/*
 * The GST report routes are mounted ADMIN-ONLY in the real app (no DB).
 *
 * Loads index.js with dotenv stubbed (no .env file is read) and a test-only
 * JWT secret, then checks that /api/reports/gst is reached only through
 * verifyToken and the admin role check, in that order, and that those two
 * layers really reject missing tokens and non-admin roles.
 */
const assert = require("node:assert/strict");
const path = require("path");
const jwt = require("jsonwebtoken");

// Never read the real .env in tests.
const dotenvPath = require.resolve("dotenv");
require.cache[dotenvPath] = {
  id: dotenvPath,
  filename: dotenvPath,
  loaded: true,
  exports: { config: () => ({ parsed: {} }) },
};
process.env.JWT_SECRET = "gst-report-mount-test-only";

const root = path.join(__dirname, "..");
const { app } = require(path.join(root, "index.js"));
const verifyToken = require(path.join(root, "src/middleware/authMiddleware"));
const gstReportRouter = require(path.join(root, "src/routes/gstReport"));

const stack = app._router.stack;
const routerIndex = stack.findIndex((layer) => layer.handle === gstReportRouter);
assert.ok(routerIndex > 1, "the GST report router is mounted");
assert.equal(
  stack.filter((layer) => layer.handle === gstReportRouter).length,
  1,
  "mounted exactly once (no unprotected second mount)"
);

const routerLayer = stack[routerIndex];
for (const url of ["/api/reports/gst/summary", "/api/reports/gst/invoices", "/api/reports/gst/hsn", "/api/reports/gst/export.csv"]) {
  assert.ok(routerLayer.regexp.test(url), `${url} is served by the report router`);
}
assert.equal(routerLayer.regexp.test("/api/reports/gstx"), false);

// The two layers right before the router guard the same path.
const authLayer = stack[routerIndex - 2];
const roleLayer = stack[routerIndex - 1];
assert.equal(authLayer.handle, verifyToken, "verifyToken runs first");
assert.ok(authLayer.regexp.test("/api/reports/gst/summary"), "verifyToken guards the report path");
assert.ok(roleLayer.regexp.test("/api/reports/gst/summary"), "the role check guards the report path");
assert.notEqual(roleLayer.handle, gstReportRouter);

// The router serves exactly the four GET endpoints.
const routes = gstReportRouter.stack
  .filter((layer) => layer.route)
  .map((layer) => `${Object.keys(layer.route.methods).join(",")} ${layer.route.path}`)
  .sort();
assert.deepEqual(routes, ["get /export.csv", "get /hsn", "get /invoices", "get /summary"]);

/* Behaviour of the guard chain: run the two real middleware layers. */
const runGuards = (authorization) => {
  const req = { headers: authorization ? { authorization } : {} };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ reached: false, status: this.statusCode, body });
      },
    };
    authLayer.handle(req, res, () =>
      roleLayer.handle(req, res, () => resolve({ reached: true, user: req.user }))
    );
  });
};

const token = (role) => jwt.sign({ id: "u1", role }, process.env.JWT_SECRET, { expiresIn: "5m" });

(async () => {
  let result = await runGuards();
  assert.deepEqual([result.reached, result.status], [false, 401], "no token: 401");

  result = await runGuards("Bearer not-a-token");
  assert.deepEqual([result.reached, result.status], [false, 401], "bad token: 401");

  for (const role of ["employee", "customer", "supplier"]) {
    result = await runGuards(`Bearer ${token(role)}`);
    assert.deepEqual([result.reached, result.status], [false, 403], `${role}: 403`);
  }

  result = await runGuards(`Bearer ${jwt.sign({ id: "u1", role: "admin" }, "some-other-secret")}`);
  assert.deepEqual([result.reached, result.status], [false, 401], "token signed with another secret: 401");

  result = await runGuards(`Bearer ${token("admin")}`);
  assert.equal(result.reached, true, "admin reaches the report router");
  assert.equal(result.user.role, "admin");

  console.log("GST report mount: admin-only, all assertions passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
