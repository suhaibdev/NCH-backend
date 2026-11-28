/*
 * Login lockout shared by every login type (admin now; customer and supplier
 * later). Each type counts failures per account and per IP. Five failures
 * inside the window lock that key; the lock ends on its own.
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_IDENTIFIER_LENGTH = 254;

const LOCKED_MESSAGE = "Too many failed attempts. Please try again later.";

const normalizeIdentifier = (value) =>
  String(value || "").trim().toLowerCase().slice(0, MAX_IDENTIFIER_LENGTH);

/** Unknown and real accounts get the same kind of key, so they behave alike. */
const buildLockoutKeys = (loginType, identifier, ip) => ({
  account: `${loginType}:acct:${normalizeIdentifier(identifier)}`,
  ip: `${loginType}:ip:${ip || "unknown"}`,
});

/*
 * One atomic update (MongoDB aggregation pipeline) for one failed attempt.
 * While locked nothing changes, so a lock is never extended. After a lock or
 * a window has ended, counting starts again at 1.
 */
const buildFailureUpdate = (now, { maxFailures, windowMs, lockMs }) => {
  const windowFloor = new Date(now.getTime() - windowMs);
  const lockEnd = new Date(now.getTime() + lockMs);

  return [
    { $set: { isLocked: { $gt: ["$lockedUntil", now] } } },
    {
      $set: {
        isFresh: {
          $and: [
            { $not: ["$isLocked"] },
            {
              $or: [
                { $ne: [{ $ifNull: ["$lockedUntil", null] }, null] },
                { $lte: [{ $ifNull: ["$windowStartedAt", new Date(0)] }, windowFloor] },
              ],
            },
          ],
        },
      },
    },
    {
      $set: {
        failures: {
          $cond: [
            "$isLocked",
            "$failures",
            { $cond: ["$isFresh", 1, { $add: [{ $ifNull: ["$failures", 0] }, 1] }] },
          ],
        },
        windowStartedAt: { $cond: ["$isFresh", now, "$windowStartedAt"] },
        lockedUntil: { $cond: ["$isFresh", null, "$lockedUntil"] },
      },
    },
    {
      $set: {
        lockedUntil: {
          $cond: [
            { $and: [{ $not: ["$isLocked"] }, { $gte: ["$failures", maxFailures] }] },
            lockEnd,
            { $ifNull: ["$lockedUntil", null] },
          ],
        },
      },
    },
    { $set: { expiresAt: { $max: [{ $add: ["$windowStartedAt", windowMs] }, "$lockedUntil"] } } },
    { $unset: ["isLocked", "isFresh"] },
  ];
};

const createLoginLockout = ({
  Model,
  now = () => new Date(),
  maxFailures = MAX_FAILURES,
  windowMs = WINDOW_MS,
  lockMs = LOCK_MS,
}) => {
  const queues = new Map();

  const waitForKey = async (key) => {
    const previous = queues.get(key) || Promise.resolve();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    queues.set(key, tail);
    await previous;
    return () => {
      release();
      if (queues.get(key) === tail) queues.delete(key);
    };
  };

  /*
   * Runs one login attempt at a time per account and per IP, so a burst of
   * parallel guesses cannot all pass check() before any failure is counted.
   * This holds for a single server instance. Keys are taken in sorted order,
   * so two attempts can never wait on each other.
   */
  const runExclusive = async (keys, task) => {
    const releases = [];
    try {
      for (const key of [keys.account, keys.ip].sort()) {
        releases.push(await waitForKey(key));
      }
      return await task();
    } finally {
      releases.reverse().forEach((release) => release());
    }
  };

  /** Which of the two keys ("account", "ip") are locked right now. */
  const check = async (keys) => {
    const current = now().getTime();
    const records = await Model.find({ key: { $in: [keys.account, keys.ip] } }).lean();
    const isLocked = (key) =>
      records.some(
        (record) =>
          record.key === key &&
          record.lockedUntil &&
          new Date(record.lockedUntil).getTime() > current
      );
    const scopes = ["account", "ip"].filter((scope) => isLocked(keys[scope]));
    return { locked: scopes.length > 0, scopes };
  };

  /** Counts a failure on both keys and returns the scopes this call locked. */
  const recordFailure = async (keys) => {
    const at = now();
    const startedLocks = [];
    for (const scope of ["account", "ip"]) {
      const record = await Model.findOneAndUpdate(
        { key: keys[scope] },
        buildFailureUpdate(at, { maxFailures, windowMs, lockMs }),
        { upsert: true, new: true }
      ).lean();
      if (
        record.lockedUntil &&
        new Date(record.lockedUntil).getTime() === at.getTime() + lockMs
      ) {
        startedLocks.push(scope);
      }
    }
    return { startedLocks };
  };

  /*
   * Clears the account count only. The IP count stays, so signing in to one
   * valid account cannot reset an attacker's count for that address.
   */
  const recordSuccess = async (keys) => {
    await Model.deleteOne({ key: keys.account });
  };

  return { check, recordFailure, recordSuccess, runExclusive };
};

module.exports = {
  LOCKED_MESSAGE,
  LOCK_MS,
  MAX_FAILURES,
  WINDOW_MS,
  buildFailureUpdate,
  buildLockoutKeys,
  createLoginLockout,
  normalizeIdentifier,
};
