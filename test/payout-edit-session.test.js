/*
 * PATCH /api/payout/:id and PATCH /api/payout/bulk/:id, without MongoDB.
 *
 * Models and mongoose.startSession are replaced with fakes. Every operation
 * carrying a session stays "in flight" for a few ms; the test fails if two
 * operations on one session are ever in flight together.
 */
const assert = require("node:assert/strict");
const path = require("path");
const mongoose = require("mongoose");

const root = path.join(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- fake session + concurrency tracker ---------------- */

const tracker = { active: 0, maxActive: 0 };
const counts = { sessions: 0, start: 0, commit: 0, abort: 0, end: 0, writes: 0, reads: 0 };
const writes = [];

const reset = () => {
  tracker.active = 0;
  tracker.maxActive = 0;
  Object.keys(counts).forEach((key) => {
    counts[key] = 0;
  });
  writes.length = 0;
};

const runOp = async (session, produce) => {
  counts.reads += 1;
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

const clone = (value) => JSON.parse(JSON.stringify(value), (key, v) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : v);

/* ---------------- fake data + models ---------------- */

const EMP = "64b000000000000000000001";
const EMP2 = "64b000000000000000000002";
const SINGLE_ID = "64c000000000000000000001";
const LATER_ID = "64c000000000000000000002";
const BULK_ID = "64d000000000000000000001";
const utc = (day) => new Date(`${day}T00:00:00.000Z`);

const db = {};
const seed = () => {
  db.attendance = [
    { employee: EMP, date: utc("2026-10-02"), advancePayment: 1000, workHours: 8 },
    { employee: EMP, date: utc("2026-11-05"), advancePayment: 300, workHours: 8 },
  ];
  db.payouts = [
    { _id: SINGLE_ID, employee: EMP, salarySlipNumber: "NCH-PAY-2026-0001", startDate: utc("2026-10-01"),
      endDate: utc("2026-10-10"), grossSalary: 5000, advanceDeducted: 400, deductions: 100,
      outstandingAdvanceBefore: 1000, outstandingAdvanceAfter: 600, netSalary: 4500, paymentMethod: "cash",
      status: "Paid", paidOn: utc("2026-10-11") },
    { _id: LATER_ID, employee: EMP, salarySlipNumber: "NCH-PAY-2026-0002", startDate: utc("2026-11-01"),
      endDate: utc("2026-11-10"), grossSalary: 5000, advanceDeducted: 700, deductions: 0, paymentMethod: "cash" },
  ];
  db.bulks = [
    { _id: BULK_ID, payoutNumber: "NCH-BULK-2026-0001", startDate: utc("2026-10-11"), endDate: utc("2026-10-20"),
      paidOn: utc("2026-10-21"), employeeCount: 2, totalGross: 7000, totalAdvanceCut: 0, totalAdvanceLeft: 0,
      totalOtherDeduction: 0, totalNetPaid: 7000,
      employees: [
        { employee: EMP, employeeName: "Aakib", grossSalary: 4000, advanceDeducted: 0, deductions: 0,
          outstandingAdvanceBefore: 600, outstandingAdvanceAfter: 600, netSalary: 4000, paymentMethod: "cash" },
        { employee: EMP2, employeeName: "Bilal", grossSalary: 3000, advanceDeducted: 0, deductions: 0,
          outstandingAdvanceBefore: 0, outstandingAdvanceAfter: 0, netSalary: 3000, paymentMethod: "cash" },
      ] },
  ];
  db.updateThrows = false;
};

const byEmployeeFilter = (filter) => {
  const value = filter.employee ?? filter["employees.employee"];
  const ids = value && value.$in ? value.$in.map(String) : [String(value)];
  return (id) => ids.includes(String(id));
};

const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(root, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const applySet = (doc, set) => Object.assign(doc, clone(set));

const fakeUpdateOne = (collection) => (filter, update, options = {}) =>
  runOp(options.session, () => {
    if (db.updateThrows) throw new Error("write conflict");
    counts.writes += 1;
    writes.push({ collection, filter, update, options });
    const doc = db[collection].find((item) => String(item._id) === String(filter._id));
    applySet(doc, update.$set);
    return { acknowledged: true, modifiedCount: 1 };
  });

stub("src/models/Employee", {
  findById: () => fakeQuery(() => ({ _id: EMP, name: "Aakib" })),
  find: () => fakeQuery(() => []),
});
stub("src/models/Attendance", {
  find: (filter) => fakeQuery(() => clone(db.attendance.filter((r) => byEmployeeFilter(filter)(r.employee)))),
});
stub("src/models/Payout", {
  findById: (id) => fakeQuery(() => clone(db.payouts.find((p) => String(p._id) === String(id)) || null)),
  find: (filter) => fakeQuery(() => clone(db.payouts.filter((p) => byEmployeeFilter(filter)(p.employee)))),
  updateOne: fakeUpdateOne("payouts"),
});
stub("src/models/BulkPayout", {
  findById: (id) => fakeQuery(() => clone(db.bulks.find((b) => String(b._id) === String(id)) || null)),
  find: (filter) => fakeQuery(() =>
    clone(db.bulks.filter((b) => b.employees.some((line) => byEmployeeFilter(filter)(line.employee))))),
  updateOne: fakeUpdateOne("bulks"),
});
stub("src/models/PayoutCounter", { findOneAndUpdate: () => runOp(null, () => ({ sequence: 1 })) });

const router = require(path.join(root, "src/routes/payout"));

const patch = (url, body) =>
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
    router.handle({ method: "PATCH", url, body, headers: {} }, res, (err) => resolve({ status: "next", body: err }));
  });

const assertSessionClean = (label) => {
  assert.ok(tracker.maxActive <= 1, `${label}: no concurrent ops on one session`);
  assert.equal(counts.end, counts.sessions, `${label}: every session ended exactly once`);
};

const originalConsoleError = console.error;

(async () => {
  console.error = () => {};
  try {
    // 0. Detector self-check.
    reset();
    const detector = createFakeSession();
    await Promise.all([fakeQuery(() => 1).session(detector), fakeQuery(() => 2).session(detector)]);
    assert.equal(tracker.maxActive, 2);

    // 1. Forbidden field -> 400 before any DB read or session.
    seed(); reset();
    let r = await patch(`/${SINGLE_ID}`, { advanceDeducted: 100, grossSalary: 1 });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, "These fields cannot be edited: grossSalary.");
    assert.equal(counts.reads, 0);
    assert.equal(counts.sessions, 0);

    r = await patch(`/bulk/${BULK_ID}`, { paymentMethod: "cash", employees: [{ employeeId: EMP, netSalary: 1 }] });
    assert.equal(r.status, 400);
    assert.equal(counts.sessions, 0);

    // 2. Invalid id / not found.
    r = await patch("/not-an-id", { deductions: 1 });
    assert.equal(r.status, 400);
    r = await patch("/64c0000000000000000000ff", { deductions: 1 });
    assert.equal(r.status, 404);
    assert.equal(counts.sessions, 0);

    // 3. Single edit success: recalculated fields written once, inside the txn.
    seed(); reset();
    r = await patch(`/${SINGLE_ID}`, { paymentMethod: "bank", advanceDeducted: "300.004", deductions: 50 });
    assert.equal(r.status, 200);
    assert.equal(r.body.paymentMethod, "bank");
    assert.equal(r.body.advanceDeducted, 300);
    assert.equal(r.body.outstandingAdvanceAfter, 700);
    assert.equal(r.body.netSalary, 4650);
    assert.equal(r.body.grossSalary, 5000);
    assert.equal(r.body.salarySlipNumber, "NCH-PAY-2026-0001");
    assert.equal(counts.writes, 1);
    assert.equal(writes[0].options.runValidators, true);
    assert.ok(writes[0].options.session, "write uses the session");
    assert.deepEqual(Object.keys(writes[0].update.$set).sort(),
      ["advanceDeducted", "deductions", "netSalary", "outstandingAdvanceAfter", "outstandingAdvanceBefore", "paymentMethod"]);
    assert.deepEqual([counts.start, counts.commit, counts.abort], [1, 1, 0]);
    assertSessionClean("single success");
    assert.equal(db.attendance.length, 2, "attendance untouched");

    // 4. No-op edit: 200, current record, no session, no write.
    seed(); reset();
    r = await patch(`/${SINGLE_ID}`, { paymentMethod: "cash", advanceDeducted: 400, deductions: "100.00" });
    assert.equal(r.status, 200);
    assert.equal(r.body._id, SINGLE_ID);
    assert.equal(counts.sessions, 0);
    assert.equal(counts.writes, 0);

    // 5. Cap / net -> 400 before any session.
    seed(); reset();
    r = await patch(`/${SINGLE_ID}`, { advanceDeducted: 1000.01 });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, "Maximum recoverable advance is ₹1000");
    r = await patch(`/${SINGLE_ID}`, { deductions: 4601 });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, "Aakib has deductions greater than gross salary.");
    assert.equal(counts.sessions, 0);

    // 6. Chronology: raising the first payout breaks the later one -> 409.
    // Later payout: advances to 11-10 = 1300; cuts before = 700 (new) + 0 bulk -> 600 < 700.
    seed(); reset();
    r = await patch(`/${SINGLE_ID}`, { advanceDeducted: 700 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "ADVANCE_CHRONOLOGY_CONFLICT");
    assert.equal(r.body.employeeName, "Aakib");
    assert.equal(r.body.conflict.payoutNumber, "NCH-PAY-2026-0002");
    assert.equal(r.body.conflict.recordedAdvanceDeducted, 700);
    assert.equal(r.body.conflict.availableAdvance, 600);
    assert.equal(r.body.ok, undefined);
    assert.equal(r.body.status, undefined);
    assert.equal(counts.sessions, 0, "conflict caught before the transaction");

    // 7. Violation appears only inside the txn (an earlier payout was created
    //    concurrently) -> rejected from the fresh re-read, aborted, ended once.
    seed(); reset();
    let reads = 0;
    const payoutModel = require(path.join(root, "src/models/Payout"));
    const originalFind = payoutModel.find;
    payoutModel.find = (filter) => fakeQuery((session) => {
      reads += 1;
      const list = clone(db.payouts.filter((p) => byEmployeeFilter(filter)(p.employee)));
      if (session) {
        list.push({ _id: "64c0000000000000000000aa", employee: EMP, salarySlipNumber: "NCH-PAY-2026-0009",
          startDate: utc("2026-09-20"), endDate: utc("2026-09-30"), advanceDeducted: 900 });
      }
      return list;
    });
    r = await patch(`/${SINGLE_ID}`, { deductions: 10 });
    payoutModel.find = originalFind;
    assert.equal(r.status, 400);
    assert.equal(r.body.message, "Maximum recoverable advance is ₹100");
    assert.ok(reads >= 2);
    assert.deepEqual([counts.start, counts.commit, counts.abort, counts.writes], [1, 0, 1, 0]);
    assertSessionClean("txn re-validation");

    // 8. Write failure -> 500, aborted, ended once.
    seed(); reset();
    db.updateThrows = true;
    r = await patch(`/${SINGLE_ID}`, { deductions: 10 });
    assert.equal(r.status, 500);
    assert.equal(r.body.message, "Unable to edit payout.");
    assert.deepEqual([counts.start, counts.commit, counts.abort], [1, 0, 1]);
    assertSessionClean("write failure");

    // 9. Bulk edit success: method on all lines, amounts on one, totals recomputed.
    seed(); reset();
    r = await patch(`/bulk/${BULK_ID}`, {
      paymentMethod: "upi",
      employees: [{ employeeId: EMP, advanceDeducted: 200, deductions: 50.555 }],
    });
    assert.equal(r.status, 200);
    const saved = r.body.payout;
    assert.deepEqual(saved.employees.map((line) => line.paymentMethod), ["upi", "upi"]);
    const aakib = saved.employees[0];
    assert.deepEqual([aakib.advanceDeducted, aakib.deductions, aakib.outstandingAdvanceBefore, aakib.outstandingAdvanceAfter, aakib.netSalary],
      [200, 50.56, 600, 400, 3749.44]);
    assert.deepEqual([saved.totalGross, saved.totalAdvanceCut, saved.totalAdvanceLeft, saved.totalOtherDeduction, saved.totalNetPaid],
      [7000, 200, 400, 50.56, 6749.44]);
    assert.equal(saved.payoutNumber, "NCH-BULK-2026-0001");
    assert.equal(saved.employeeCount, 2);
    assert.equal(counts.writes, 1);
    assert.deepEqual([counts.start, counts.commit, counts.abort], [1, 1, 0]);
    assertSessionClean("bulk success");

    // 10. Bulk raise that breaks the later single payout -> 409.
    // Later: 1300 - (400 + 300) = 600 < 700.
    seed(); reset();
    r = await patch(`/bulk/${BULK_ID}`, { employees: [{ employeeId: EMP, advanceDeducted: 300 }] });
    assert.equal(r.status, 409);
    assert.equal(r.body.conflict.payoutNumber, "NCH-PAY-2026-0002");
    assert.equal(counts.sessions, 0);

    // 11. Bulk no-op and unknown employee.
    seed(); reset();
    r = await patch(`/bulk/${BULK_ID}`, { paymentMethod: "cash", employees: [{ employeeId: EMP, advanceDeducted: 0 }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.payout._id, BULK_ID);
    assert.equal(counts.sessions, 0);
    r = await patch(`/bulk/${BULK_ID}`, { employees: [{ employeeId: "64b0000000000000000000ff", deductions: 1 }] });
    assert.equal(r.status, 400);
    r = await patch("/bulk/64d0000000000000000000ff", { paymentMethod: "upi" });
    assert.equal(r.status, 404);
    assert.equal(counts.writes, 0);

    console.log("payout-edit-session tests passed");
  } finally {
    console.error = originalConsoleError;
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
