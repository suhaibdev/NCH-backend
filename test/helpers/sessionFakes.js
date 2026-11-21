/*
 * Shared fakes for the session-safety tests (no MongoDB).
 *
 * Every operation that carries a session stays "in flight" for a few
 * milliseconds; `tracker.maxActive` records the highest number of session
 * operations ever running together (MongoDB transactions allow only one).
 */
const path = require("path");
const mongoose = require("mongoose");

const root = path.join(__dirname, "..", "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await sleep(3);
    tracker.active -= 1;
  } else {
    await sleep(1);
  }
  return produce(session);
};

// Mimics session.withTransaction: run once, abort once only if still active, rethrow.
const createFakeSession = () => {
  let inTxn = false;
  return {
    inTransaction: () => inTxn,
    async withTransaction(fn) {
      counts.start += 1;
      inTxn = true;
      try {
        await fn(this);
        counts.commit += 1;
        inTxn = false;
      } catch (err) {
        if (inTxn) {
          counts.abort += 1;
          inTxn = false;
        }
        throw err;
      }
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

// Chainable thenable query; resolves through runOp with its bound session.
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
    sort: () => query,
    limit: () => query,
    then(resolve, reject) {
      return runOp(query.boundSession, produce).then(resolve, reject);
    },
  };
  return query;
};

const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(root, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const call = (router, method, url, body) =>
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
    router.handle({ method, url, body, headers: {} }, res, (err) =>
      resolve({ status: "next", body: err })
    );
  });

module.exports = {
  root,
  tracker,
  counts,
  resetCounters,
  runOp,
  createFakeSession,
  fakeQuery,
  stub,
  call,
};
