/*
 * Single payout create (POST /api/payout) session safety, without MongoDB.
 *
 * Models and mongoose.startSession are replaced with fakes. Every operation
 * that carries a session stays "in flight" for a few milliseconds; the test
 * fails if two operations on the same session are ever in flight together
 * (MongoDB transactions do not support parallel operations).
 */
const assert = require("node:assert/strict");
const path = require("path");
const mongoose = require("mongoose");

const root = path.join(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- fake session + concurrency tracker ---------------- */

const tracker = { active: 0, maxActive: 0 };
const counts = { sessions: 0, start: 0, commit: 0, abort: 0, end: 0 };

const resetCounters = () => {
  tracker.active = 0;
  tracker.maxActive = 0;
  Object.keys(counts).forEach((key) => {
    counts[key] = 0;
  });
};

const runOp = async (session, produce) => {
  if (session) {
    tracker.active += 1;
    tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
    await sleep(5);
    tracker.active -= 1;
  } else {
    await sleep(1);
  }
  return produce(session);
};

const createFakeSession = () => {
  let inTxn = false;
  return {
    startTransaction() {
      counts.start += 1;
      inTxn = true;
    },
    inTransaction: () => inTxn,
    async commitTransaction() {
      counts.commit += 1;
      inTxn = false;
    },
    async abortTransaction() {
      counts.abort += 1;
      inTxn = false;
    },
    async endSession() {
      counts.end += 1;
    },
  };
};

mongoose.startSession = async () => {
  counts.sessions += 1;
  return createFakeSession();
};

// Chainable thenable query; resolves through runOp with its session (if any).
const fakeQuery = (produce) => {
  const query = {
    boundSession: null,
    session(session) {
      query.boundSession = session;
      return query;
    },
    lean: () => query,
    select: () => query,
    populate: () => query,
    then(resolve, reject) {
      return runOp(query.boundSession, produce).then(resolve, reject);
    },
  };
  return query;
};

/* ---------------- fake models ---------------- */

const EMPLOYEE_ID = "64b000000000000000000001";
const scenario = {};

const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(root, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stub("src/models/Employee", {
  findById: () =>
    fakeQuery(() => ({
      _id: EMPLOYEE_ID,
      name: "Aakib",
      isActive: true,
      baseDailySalary: 800,
    })),
  find: () => fakeQuery(() => [{ _id: EMPLOYEE_ID, name: "Aakib" }]),
});

stub("src/models/Attendance", {
  find: () =>
    fakeQuery(() => [
      { employee: EMPLOYEE_ID, date: new Date("2025-10-02T00:00:00.000Z"), workHours: 8, overtime: 0, advancePayment: 0 },
      { employee: EMPLOYEE_ID, date: new Date("2025-10-03T00:00:00.000Z"), workHours: 8, overtime: 0, advancePayment: 0 },
    ]),
});

function FakePayout(doc) {
  Object.assign(this, doc);
}
FakePayout.prototype.save = function save(options = {}) {
  return runOp(options.session, () => {
    this._id = "new-payout";
    this.populate = async () => this;
    return this;
  });
};
FakePayout.find = () => fakeQuery((session) => scenario.legacyPayouts(session));
stub("src/models/Payout", FakePayout);

stub("src/models/BulkPayout", {
  find: () => fakeQuery((session) => scenario.bulkPayouts(session)),
});

stub("src/models/PayoutCounter", {
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () => {
      if (scenario.counterThrows) throw new Error("counter write failed");
      return { sequence: 7 };
    }),
});

const router = require(path.join(root, "src/routes/payout"));
const { findAttendanceLocks } = require(path.join(root, "src/utils/attendanceLock"));

/* ---------------- helpers ---------------- */

const coveringBulk = {
  _id: "bulk-1",
  payoutNumber: "NCH-BULK-2025-0001",
  startDate: new Date("2025-10-01T00:00:00.000Z"),
  endDate: new Date("2025-10-10T00:00:00.000Z"),
  paidOn: new Date("2025-10-10T00:00:00.000Z"),
  employees: [{ employee: EMPLOYEE_ID, employeeName: "Aakib", advanceDeducted: 0 }],
};

const post = (body) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
      },
    };
    router.handle({ method: "POST", url: "/", body, headers: {} }, res, (err) =>
      resolve({ status: "next", body: err })
    );
  });

const baseBody = {
  employeeId: EMPLOYEE_ID,
  startDate: "2025-10-02",
  endDate: "2025-10-05",
  paymentMethod: "cash",
};

const setScenario = ({ legacy = () => [], bulk = () => [], counterThrows = false } = {}) => {
  scenario.legacyPayouts = legacy;
  scenario.bulkPayouts = bulk;
  scenario.counterThrows = counterThrows;
  resetCounters();
};

const originalConsoleError = console.error;

(async () => {
  console.error = () => {};
  try {
    // 0. Detector self-check: parallel operations on one session are caught.
    resetCounters();
    const detectorSession = createFakeSession();
    await Promise.all([
      fakeQuery(() => 1).session(detectorSession),
      fakeQuery(() => 2).session(detectorSession),
    ]);
    assert.equal(tracker.maxActive, 2, "detector notices overlapping session operations");

    // 1. Overlap with a bulk payout found before any transaction -> 409, no session.
    setScenario({ bulk: () => [coveringBulk] });
    let result = await post(baseBody);
    assert.equal(result.status, 409, "overlap with bulk payout returns 409");
    assert.equal(result.body.code, "PAYOUT_OVERLAP");
    assert.equal(result.body.message, "A payout for an overlapping period already exists.");
    assert.equal(result.body.employeeName, "Aakib");
    assert.equal(result.body.overlap.sourceType, "bulk");
    assert.equal(result.body.overlap.parentBulkPayout.payoutNumber, "NCH-BULK-2025-0001");
    assert.equal(counts.sessions, 0, "no session is opened when validation fails");

    // 2. Overlap appears only inside the transaction (race) -> 409, one abort, one end.
    setScenario({ bulk: (session) => (session ? [coveringBulk] : []) });
    result = await post(baseBody);
    assert.equal(result.status, 409, "in-transaction overlap re-check returns 409");
    assert.equal(result.body.code, "PAYOUT_OVERLAP");
    assert.equal(result.body.overlap.sourceType, "bulk");
    assert.equal(counts.sessions, 1);
    assert.equal(counts.start, 1);
    assert.equal(counts.abort, 1, "transaction aborted exactly once");
    assert.equal(counts.end, 1, "session ended exactly once");
    assert.equal(counts.commit, 0);
    assert.ok(tracker.maxActive <= 1, "never two session operations at once (race path)");

    // 3. Net salary below zero -> 400, no session.
    setScenario();
    result = await post({ ...baseBody, deductions: 999999 });
    assert.equal(result.status, 400, "net salary below zero returns 400");
    assert.equal(result.body.message, "Aakib has deductions greater than gross salary.");
    assert.equal(counts.sessions, 0);

    // 4. Success -> 201, one commit, one end, no abort, never parallel.
    setScenario();
    result = await post(baseBody);
    assert.equal(result.status, 201, "valid payout is created");
    assert.equal(result.body.salarySlipNumber, `NCH-PAY-${new Date().getFullYear()}-0007`);
    assert.equal(counts.commit, 1);
    assert.equal(counts.abort, 0);
    assert.equal(counts.end, 1);
    assert.ok(tracker.maxActive <= 1, "never two session operations at once (success path)");

    // 5. Failure inside the transaction -> 500, one abort, one end.
    setScenario({ counterThrows: true });
    result = await post(baseBody);
    assert.equal(result.status, 500);
    assert.equal(counts.abort, 1);
    assert.equal(counts.end, 1);
    assert.equal(counts.commit, 0);

    // 6. Attendance lock lookup with a session runs its reads one at a time.
    setScenario({ bulk: () => [coveringBulk] });
    const locked = await findAttendanceLocks({
      employeeIds: [EMPLOYEE_ID],
      date: new Date("2025-10-03T00:00:00.000Z"),
      session: createFakeSession(),
    });
    assert.equal(locked.length, 1);
    assert.equal(locked[0].payoutNumber, "NCH-BULK-2025-0001");
    assert.ok(tracker.maxActive <= 1, "attendance lock lookup never runs session reads in parallel");
  } finally {
    console.error = originalConsoleError;
  }

  console.log("Single payout session safety: 6 scenarios passed.");
})().catch((err) => {
  console.error = originalConsoleError;
  console.error(err);
  process.exit(1);
});
