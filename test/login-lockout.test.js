/*
 * Login lockout: the rules (through the real update pipeline) and the real
 * login route. No database, no port, no .env.
 */
const assert = require("node:assert/strict");
const path = require("path");
const { dispatch, loadApp, root } = require("./helpers/appHarness");
const { createLoginAttemptFake } = require("./helpers/loginAttemptFake");

const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const LoginAttempt = require(path.join(root, "src/models/LoginAttempt"));
const {
  LOCK_MS,
  MAX_FAILURES,
  WINDOW_MS,
  buildFailureUpdate,
  buildLockoutKeys,
  createLoginLockout,
} = require(path.join(root, "src/utils/loginLockout"));
const { DUMMY_PASSWORD_HASH } = require(path.join(root, "src/utils/guardedLogin"));

const MINUTE = 60 * 1000;

const setup = () => {
  const Model = createLoginAttemptFake();
  const clock = { time: Date.parse("2026-11-28T06:00:00.000Z") };
  const lockout = createLoginLockout({ Model, now: () => new Date(clock.time) });
  const advance = (ms) => {
    clock.time += ms;
  };
  return { Model, lockout, advance };
};

const failTimes = async (lockout, keys, times) => {
  let last;
  for (let count = 0; count < times; count += 1) last = await lockout.recordFailure(keys);
  return last;
};

const unitTests = async () => {
  assert.deepEqual([MAX_FAILURES, WINDOW_MS, LOCK_MS], [5, 15 * MINUTE, 15 * MINUTE]);

  // Keys: normalized account, separate per login type.
  assert.deepEqual(buildLockoutKeys("admin", "  Boss@Example.COM ", "1.2.3.4"), {
    account: "admin:acct:boss@example.com",
    ip: "admin:ip:1.2.3.4",
  });
  assert.notEqual(
    buildLockoutKeys("admin", "a@b.c", "1.1.1.1").account,
    buildLockoutKeys("customer", "a@b.c", "1.1.1.1").account
  );

  // 4 failures do not lock; the 5th does.
  {
    const { lockout } = setup();
    const keys = buildLockoutKeys("admin", "a@example.com", "1.1.1.1");
    const fourth = await failTimes(lockout, keys, 4);
    assert.deepEqual(fourth.startedLocks, []);
    assert.equal((await lockout.check(keys)).locked, false, "4 failures: not locked");
    const fifth = await lockout.recordFailure(keys);
    assert.deepEqual(fifth.startedLocks, ["account", "ip"]);
    assert.deepEqual(await lockout.check(keys), { locked: true, scopes: ["account", "ip"] });
  }

  // The lock expires on its own after 15 minutes, and counting restarts at 1.
  {
    const { lockout, advance, Model } = setup();
    const keys = buildLockoutKeys("admin", "a@example.com", "1.1.1.1");
    await failTimes(lockout, keys, 5);
    advance(LOCK_MS - 1);
    assert.equal((await lockout.check(keys)).locked, true, "still locked just before the end");

    // A failure counted during the lock never extends it.
    const lockedUntil = Model.records.get(keys.account).lockedUntil.getTime();
    assert.deepEqual((await lockout.recordFailure(keys)).startedLocks, []);
    assert.equal(Model.records.get(keys.account).lockedUntil.getTime(), lockedUntil);

    advance(1);
    assert.equal((await lockout.check(keys)).locked, false, "unlocked after 15 minutes");
    await lockout.recordFailure(keys);
    assert.equal(Model.records.get(keys.account).failures, 1, "counting restarts");
    assert.equal(Model.records.get(keys.account).lockedUntil, null);
    assert.equal((await lockout.check(keys)).locked, false);
  }

  // Failures older than the window do not count.
  {
    const { lockout, advance, Model } = setup();
    const keys = buildLockoutKeys("admin", "a@example.com", "1.1.1.1");
    await failTimes(lockout, keys, 4);
    advance(WINDOW_MS);
    await lockout.recordFailure(keys);
    assert.equal(Model.records.get(keys.account).failures, 1);
    assert.equal((await lockout.check(keys)).locked, false);
  }

  // expiresAt (TTL) is never before the end of the window or the lock.
  {
    const { lockout, advance, Model } = setup();
    const keys = buildLockoutKeys("admin", "a@example.com", "1.1.1.1");
    await lockout.recordFailure(keys);
    const first = Model.records.get(keys.account);
    assert.equal(first.expiresAt.getTime(), first.windowStartedAt.getTime() + WINDOW_MS);
    advance(10 * MINUTE);
    await failTimes(lockout, keys, 4);
    const locked = Model.records.get(keys.account);
    assert.equal(locked.expiresAt.getTime(), locked.lockedUntil.getTime());
  }

  // Per account: one account attacked from many IPs locks the account only.
  {
    const { lockout } = setup();
    for (let index = 1; index <= 5; index += 1) {
      await lockout.recordFailure(buildLockoutKeys("admin", "victim@example.com", `2.0.0.${index}`));
    }
    const fresh = buildLockoutKeys("admin", "victim@example.com", "9.9.9.9");
    assert.deepEqual(await lockout.check(fresh), { locked: true, scopes: ["account"] });
    const otherAccount = buildLockoutKeys("admin", "other@example.com", "2.0.0.1");
    assert.equal((await lockout.check(otherAccount)).locked, false);
    const otherType = buildLockoutKeys("customer", "victim@example.com", "9.9.9.9");
    assert.equal((await lockout.check(otherType)).locked, false);
  }

  // Per IP: one IP trying many accounts locks the IP only.
  {
    const { lockout } = setup();
    for (let index = 1; index <= 5; index += 1) {
      await lockout.recordFailure(buildLockoutKeys("admin", `user${index}@example.com`, "3.3.3.3"));
    }
    const sameIp = buildLockoutKeys("admin", "never-tried@example.com", "3.3.3.3");
    assert.deepEqual(await lockout.check(sameIp), { locked: true, scopes: ["ip"] });
    const otherIp = buildLockoutKeys("admin", "user1@example.com", "4.4.4.4");
    assert.equal((await lockout.check(otherIp)).locked, false);
  }

  // A success clears the account count only.
  {
    const { lockout, Model } = setup();
    const keys = buildLockoutKeys("admin", "a@example.com", "1.1.1.1");
    await failTimes(lockout, keys, 4);
    await lockout.recordSuccess(keys);
    assert.equal(Model.records.has(keys.account), false);
    assert.equal(Model.records.get(keys.ip).failures, 4, "the IP count stays");
  }

  // Attempts sharing a key run one at a time; a failing task releases its keys.
  {
    const { lockout } = setup();
    const keys = buildLockoutKeys("admin", "a@example.com", "1.1.1.1");
    const sameIp = buildLockoutKeys("admin", "b@example.com", "1.1.1.1");
    let running = 0;
    let highest = 0;
    const task = async () => {
      running += 1;
      highest = Math.max(highest, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
    };
    await Promise.all([keys, sameIp, keys, sameIp].map((k) => lockout.runExclusive(k, task)));
    assert.equal(highest, 1);
    await assert.rejects(
      lockout.runExclusive(keys, async () => {
        throw new Error("boom");
      }),
      /boom/
    );
    assert.equal(await lockout.runExclusive(keys, async () => "free"), "free");
  }

  // Mongoose accepts the pipeline update (cast only; nothing is sent).
  {
    const update = buildFailureUpdate(new Date(), {
      maxFailures: 5,
      windowMs: WINDOW_MS,
      lockMs: LOCK_MS,
    });
    const query = LoginAttempt.findOneAndUpdate({ key: "k" }, update, { upsert: true, new: true });
    const cast = query._castUpdate(query.getUpdate());
    assert.ok(Array.isArray(cast));
    assert.equal(cast.length, update.length);
  }

  // Schema: unique key and a TTL index that removes records by expiresAt.
  const indexes = LoginAttempt.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => fields.key === 1 && options.unique));
  assert.ok(
    indexes.some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0)
  );
};

const routeTests = async () => {
  const REAL_EMAIL = "boss@example.com";
  const PASSWORD = "correct-horse-test-only";
  const { app } = loadApp({ env: { JWT_SECRET: "lockout-test-only" } });

  const fake = createLoginAttemptFake();
  LoginAttempt.find = fake.find;
  LoginAttempt.findOneAndUpdate = fake.findOneAndUpdate;
  LoginAttempt.deleteOne = fake.deleteOne;

  const user = {
    _id: new mongoose.Types.ObjectId(),
    name: "Boss",
    email: REAL_EMAIL,
    role: "admin",
    password: await bcrypt.hash(PASSWORD, 4),
  };
  const User = require(path.join(root, "src/models/User"));
  let userLookups = 0;
  User.findOne = async ({ email }) => {
    userLookups += 1;
    return email === REAL_EMAIL ? user : null;
  };

  const audits = [];
  const AuditLog = require(path.join(root, "src/models/AuditLog"));
  AuditLog.create = async (entry) => {
    audits.push(entry);
    return entry;
  };

  const compared = [];
  const realCompare = bcrypt.compare;
  bcrypt.compare = (password, hash) => {
    compared.push(hash);
    return realCompare(password, hash);
  };

  const login = (email, password, ip) =>
    dispatch(app, { method: "POST", url: "/api/auth/login", body: { email, password }, ip });

  // Existing 400, also for non-text values, for real and unknown accounts alike.
  for (const body of [
    {},
    { email: REAL_EMAIL },
    { email: REAL_EMAIL, password: 12345 },
    { email: "nobody@example.com", password: 12345 },
    { email: { $ne: null }, password: "x" },
  ]) {
    const result = await dispatch(app, {
      method: "POST",
      url: "/api/auth/login",
      body,
      ip: "20.0.0.1",
    });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { success: false, message: "Email and password are required." });
  }
  assert.equal(userLookups, 0);

  // Success keeps the existing response shape.
  let result = await login(`  ${REAL_EMAIL.toUpperCase()} `, PASSWORD, "21.0.0.1");
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body), ["success", "token", "user"]);
  assert.deepEqual(Object.keys(result.body.user), ["id", "name", "email", "role"]);
  assert.equal(audits.at(-1).action, "login.success");
  assert.equal(String(audits.at(-1).actor), String(user._id));
  assert.equal(audits.at(-1).actorRole, "admin");
  assert.equal(audits.at(-1).identifier, REAL_EMAIL);
  assert.equal(audits.at(-1).ip, "21.0.0.1", "the client IP comes from the proxy header");

  // Real and unknown accounts must look exactly the same, before and after locking.
  const run = async (email, ip) => {
    const seen = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await login(email, "wrong-password", ip);
      seen.push([response.status, response.body]);
    }
    return seen;
  };
  audits.length = 0;
  const real = await run(REAL_EMAIL, "22.0.0.1");
  const realAudits = audits.map((entry) => entry.action);
  audits.length = 0;
  compared.length = 0;
  const unknown = await run("ghost@example.com", "23.0.0.1");

  assert.deepEqual(real, unknown, "no difference between real and unknown accounts");
  assert.deepEqual(
    real.map(([status]) => status),
    [401, 401, 401, 401, 401, 429]
  );
  assert.deepEqual(real[0][1], { success: false, message: "Invalid email or password." });
  assert.deepEqual(real[5][1], {
    success: false,
    message: "Too many failed attempts. Please try again later.",
  });
  assert.deepEqual(audits.map((entry) => entry.action), realAudits);
  assert.deepEqual(realAudits, [
    "login.failure",
    "login.failure",
    "login.failure",
    "login.failure",
    "login.failure",
    "login.lockout",
    "login.lockout",
  ]);
  assert.ok(audits.every((entry) => entry.actor === null));
  assert.equal(JSON.stringify(audits).includes("wrong-password"), false, "no password is logged");
  assert.deepEqual(compared, Array(5).fill(DUMMY_PASSWORD_HASH), "unknown: dummy hash compared");
  assert.equal(bcrypt.getRounds(DUMMY_PASSWORD_HASH), 12, "same cost as createAdmin.js");

  // The correct password is refused while the account is locked, even from a new IP.
  const lookupsBefore = userLookups;
  result = await login(REAL_EMAIL, PASSWORD, "24.0.0.1");
  assert.equal(result.status, 429);
  assert.equal(userLookups, lookupsBefore, "no password check while locked");

  // A locked IP is refused for any account.
  result = await login("someone-else@example.com", "x", "23.0.0.1");
  assert.equal(result.status, 429);

  // A burst of parallel guesses still gets only 5 password checks.
  compared.length = 0;
  const burst = await Promise.all(
    Array.from({ length: 10 }, () => login("burst@example.com", "guess", "25.0.0.1"))
  );
  assert.equal(compared.length, 5);
  assert.equal(burst.filter((response) => response.status === 401).length, 5);
  assert.equal(burst.filter((response) => response.status === 429).length, 5);

  // A broken audit log does not break logins.
  AuditLog.create = async () => {
    throw new Error("audit down");
  };
  const originalError = console.error;
  console.error = () => {};
  fake.records.clear();
  result = await login(REAL_EMAIL, PASSWORD, "26.0.0.1");
  console.error = originalError;
  assert.equal(result.status, 200);

  bcrypt.compare = realCompare;
};

(async () => {
  await unitTests();
  await routeTests();
  console.log("Login lockout: all assertions passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
