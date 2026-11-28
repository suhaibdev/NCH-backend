/*
 * Audit log: append-only, admin-only read route, filters and Asia/Kolkata
 * date bounds, and the recordAudit helper. No database, no port, no .env.
 */
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { dispatch, loadApp, root } = require("./helpers/appHarness");

const { app } = loadApp({ env: { JWT_SECRET: "audit-log-test-only" } });
const mongoose = require("mongoose");
// If a guard were missing, the operation would wait for a database: fail fast.
mongoose.set("bufferTimeoutMS", 100);

const AuditLog = require(path.join(root, "src/models/AuditLog"));
const auditRouter = require(path.join(root, "src/routes/auditLog"));
const { parseAuditFilter } = auditRouter;
const { MAX_DETAILS_LENGTH, recordAudit } = require(path.join(root, "src/utils/auditLog"));
console.log = () => {};

const APPEND_ONLY = { message: AuditLog.APPEND_ONLY_MESSAGE };
const id = "64b000000000000000000001";

const appendOnlyTests = async () => {
  const stored = () => AuditLog.hydrate({ _id: id, action: "login.success" });
  const attempts = {
    updateOne: () => AuditLog.updateOne({ _id: id }, { action: "x" }),
    updateMany: () => AuditLog.updateMany({}, { action: "x" }),
    findOneAndUpdate: () => AuditLog.findOneAndUpdate({ _id: id }, { action: "x" }),
    findByIdAndUpdate: () => AuditLog.findByIdAndUpdate(id, { action: "x" }),
    replaceOne: () => AuditLog.replaceOne({ _id: id }, { action: "x" }),
    findOneAndReplace: () => AuditLog.findOneAndReplace({ _id: id }, { action: "x" }),
    deleteOne: () => AuditLog.deleteOne({ _id: id }),
    deleteMany: () => AuditLog.deleteMany({}),
    findOneAndDelete: () => AuditLog.findOneAndDelete({ _id: id }),
    findByIdAndDelete: () => AuditLog.findByIdAndDelete(id),
    findOneAndRemove: () => AuditLog.findOneAndRemove({ _id: id }),
    findByIdAndRemove: () => AuditLog.findByIdAndRemove(id),
    bulkWrite: () => AuditLog.bulkWrite([{ deleteMany: { filter: {} } }]),
    documentDeleteOne: () => stored().deleteOne(),
    documentUpdateOne: () => stored().updateOne({ action: "x" }),
    saveExisting: () => {
      const document = stored();
      document.action = "changed";
      return document.save();
    },
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    await assert.rejects(async () => attempt(), APPEND_ONLY, `${name} is refused`);
  }

  assert.equal(AuditLog.schema.path("createdAt").options.immutable, true);
  assert.ok(
    AuditLog.schema.indexes().every(([, options]) => options.expireAfterSeconds === undefined),
    "kept forever: no TTL index"
  );
  assert.deepEqual(
    Object.keys(AuditLog.schema.paths).sort(),
    [
      "_id",
      "action",
      "actor",
      "actorRole",
      "createdAt",
      "details",
      "identifier",
      "ip",
      "recordId",
      "recordType",
    ]
  );
};

/* Only the helper (create) and the read route may use the model. */
const sourceScan = () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith(".js") && !full.endsWith(".test.js")) files.push(full);
    }
  };
  walk(path.join(root, "src"));
  files.push(path.join(root, "index.js"), path.join(root, "createAdmin.js"));

  const allowedCalls = {
    "src/utils/auditLog.js": ["create"],
    "src/routes/auditLog.js": ["find", "countDocuments"],
  };
  const users = [];
  for (const file of files) {
    const name = path.relative(root, file).split(path.sep).join("/");
    if (name === "src/models/AuditLog.js") continue;
    const source = fs.readFileSync(file, "utf8");
    assert.equal(/auditlogs|["'`]AuditLog["'`]/.test(source), false, `${name}: no indirect use`);
    if (!/models\/AuditLog["']/.test(source)) continue;
    users.push(name);
    assert.ok(allowedCalls[name], `${name} must not import the AuditLog model`);
    const calls = [...source.matchAll(/\bAuditLog\s*(?:\.\s*(\w+)|\[)/g)].map((m) => m[1]);
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(allowedCalls[name].includes(call), `${name}: AuditLog.${call} is not allowed`);
    }
  }
  assert.deepEqual(users.sort(), Object.keys(allowedCalls).sort());
};

const filterTests = () => {
  assert.deepEqual(parseAuditFilter({}), { valid: true, value: {} });
  assert.deepEqual(parseAuditFilter({ action: "", from: "", to: "" }).value, {});
  assert.deepEqual(parseAuditFilter({ action: "login.failure", recordType: "auth" }).value, {
    action: "login.failure",
    recordType: "auth",
  });

  // 1 April is 31 March 18:30 UTC to 1 April 18:30 UTC.
  const day = parseAuditFilter({ from: "2027-04-01", to: "2027-04-01" }).value.createdAt;
  assert.equal(day.$gte.toISOString(), "2027-03-31T18:30:00.000Z");
  assert.equal(day.$lt.toISOString(), "2027-04-01T18:30:00.000Z");
  const inside = (value) => new Date(value) >= day.$gte && new Date(value) < day.$lt;
  assert.equal(inside("2027-04-01T00:00:00+05:30"), true, "1 April 00:00 IST");
  assert.equal(inside("2027-04-01T23:59:59.999+05:30"), true, "1 April 23:59 IST");
  assert.equal(inside("2027-03-31T23:59:59.999+05:30"), false, "31 March 23:59 IST");
  assert.equal(inside("2027-04-02T00:00:00+05:30"), false, "2 April 00:00 IST");

  assert.deepEqual(Object.keys(parseAuditFilter({ from: "2027-04-01" }).value.createdAt), ["$gte"]);
  assert.deepEqual(Object.keys(parseAuditFilter({ to: "2027-04-01" }).value.createdAt), ["$lt"]);

  for (const bad of [
    { from: "2027-02-30" },
    { to: "01-04-2027" },
    { from: "2027-04-01T00:00:00Z" },
    { from: ["2027-04-01", "2027-04-02"] },
    { from: "2027-04-02", to: "2027-04-01" },
    { action: { $ne: "" } },
    { recordType: ["auth"] },
    { action: "x".repeat(81) },
  ]) {
    assert.equal(parseAuditFilter(bad).valid, false, JSON.stringify(bad));
  }
};

const routeTests = async () => {
  const routes = auditRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods).join(",")} ${layer.route.path}`);
  assert.deepEqual(routes, ["get /"], "read-only router");

  const calls = [];
  AuditLog.find = (filter) => {
    const call = { filter };
    calls.push(call);
    const chain = {
      sort(value) {
        call.sort = value;
        return chain;
      },
      skip(value) {
        call.skip = value;
        return chain;
      },
      limit(value) {
        call.limit = value;
        return chain;
      },
      lean: async () => [{ action: "login.success" }],
    };
    return chain;
  };
  AuditLog.countDocuments = async () => 250;

  let ip = 0;
  const get = (query, role = "admin", method = "GET", suffix = "") => {
    ip += 1;
    const headers = role
      ? {
          authorization: `Bearer ${jwt.sign({ id, role }, process.env.JWT_SECRET, {
            expiresIn: "5m",
          })}`,
        }
      : {};
    return dispatch(app, {
      method,
      url: `/api/audit-log${suffix}${query}`,
      headers,
      ip: `50.0.0.${ip}`,
    });
  };

  assert.equal((await get("", null)).status, 401);
  for (const role of ["customer", "supplier", "employee"]) {
    assert.equal((await get("", role)).status, 403, role);
  }
  assert.equal(calls.length, 0);

  // No way to change or remove a record over HTTP, even for an admin.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await get("", "admin", method)).status, 404, method);
    assert.equal((await get("", "admin", method, `/${id}`)).status, 404, `${method} /:id`);
  }

  let response = await get("");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    items: [{ action: "login.success" }],
    page: 1,
    limit: 20,
    total: 250,
    totalPages: 13,
  });
  assert.deepEqual(calls.at(-1).sort, { createdAt: -1, _id: -1 });
  assert.deepEqual([calls.at(-1).skip, calls.at(-1).limit], [0, 20]);

  response = await get("?page=3&limit=5000&action=login.lockout&from=2027-04-01");
  assert.deepEqual([calls.at(-1).skip, calls.at(-1).limit], [200, 100], "limit capped at 100");
  assert.equal(calls.at(-1).filter.action, "login.lockout");
  assert.equal(calls.at(-1).filter.createdAt.$gte.toISOString(), "2027-03-31T18:30:00.000Z");

  await get("?page=-4&limit=abc");
  assert.deepEqual([calls.at(-1).skip, calls.at(-1).limit], [0, 20]);

  const before = calls.length;
  for (const query of ["?from=bad", "?from=2027-04-02&to=2027-04-01", "?action[$ne]=x"]) {
    assert.equal((await get(query)).status, 400, query);
  }
  assert.equal(calls.length, before, "nothing is queried for a bad filter");

  AuditLog.countDocuments = async () => {
    throw new Error("internal database detail");
  };
  const originalError = console.error;
  console.error = () => {};
  response = await get("");
  console.error = originalError;
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { message: "Something went wrong. Please try again." });
};

const helperTests = async () => {
  const created = [];
  AuditLog.create = async (...args) => {
    created.push(args);
    return Array.isArray(args[0]) ? args[0] : { ...args[0] };
  };

  const req = { ip: "1.2.3.4", user: { id, role: "admin" } };
  let record = await recordAudit({
    req,
    action: "invoice.reverse",
    recordType: "invoice",
    recordId: 42,
    details: { reason: "wrong", password: "p", nested: { jwtToken: "t" } },
  });
  assert.deepEqual(record, {
    actor: id,
    actorRole: "admin",
    identifier: "",
    action: "invoice.reverse",
    recordType: "invoice",
    recordId: "42",
    details: { reason: "wrong", password: "[redacted]", nested: { jwtToken: "[redacted]" } },
    ip: "1.2.3.4",
  });
  assert.equal(new AuditLog(record).validateSync(), undefined, "matches the schema");

  record = await recordAudit({ action: "x", details: { blob: "x".repeat(MAX_DETAILS_LENGTH) } });
  assert.deepEqual(record.details, { truncated: true });
  assert.equal(record.actor, null);

  const session = { fake: true };
  await recordAudit({ action: "payment.record", session });
  assert.ok(Array.isArray(created.at(-1)[0]));
  assert.equal(created.at(-1)[1].session, session);

  AuditLog.create = async () => {
    throw new Error("write failed");
  };
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  assert.equal(await recordAudit({ action: "login.success" }), null, "default: continue");
  const circular = {};
  circular.self = circular;
  assert.equal(await recordAudit({ action: "x", details: circular }), null, "never throws");
  console.error = originalError;
  assert.equal(logged.length, 2, "the failure is logged");
  assert.match(logged[0], /login\.success.*write failed/);

  await assert.rejects(recordAudit({ action: "payment.void", failClosed: true }), /write failed/);
  await assert.rejects(recordAudit({ action: "x", details: circular, failClosed: true }));
  await assert.rejects(
    recordAudit({ action: "payment.void", session }),
    /write failed/,
    "inside a transaction the error always reaches the caller"
  );
};

(async () => {
  await appendOnlyTests();
  sourceScan();
  filterTests();
  await routeTests();
  await helperTests();
  process.stdout.write("Audit log: all assertions passed.\n");
})().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
