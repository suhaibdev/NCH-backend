/*
 * Rate limits on the real app: login, enquiry placeholder and general API.
 * No database, no port, no .env.
 */
const assert = require("node:assert/strict");
const path = require("path");
const { dispatch, loadApp, root } = require("./helpers/appHarness");

const origin = "https://app.example";
const { app } = loadApp({
  env: { JWT_SECRET: "rate-limit-test-only", CORS_ALLOWED_ORIGINS: origin },
});
const { RATE_LIMITS } = require(path.join(root, "src/middleware/rateLimits"));
console.log = () => {}; // request timing lines
const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.join(" "));

const expectLimit = async (request, { limit, status, message, windowSeconds }) => {
  for (let count = 1; count <= limit; count += 1) {
    const response = await dispatch(app, request);
    assert.equal(response.status, status, `request ${count} of ${limit} is allowed`);
  }
  const blocked = await dispatch(app, {
    ...request,
    headers: { ...request.headers, origin },
  });
  assert.equal(blocked.status, 429, `request ${limit + 1} is refused`);
  assert.deepEqual(blocked.body, { success: false, message });
  assert.equal(Number(blocked.headers["ratelimit-limit"]), limit);
  assert.equal(Number(blocked.headers["ratelimit-remaining"]), 0);
  const retryAfter = Number(blocked.headers["retry-after"]);
  assert.ok(retryAfter > windowSeconds - 30 && retryAfter <= windowSeconds, "Retry-After");
  assert.equal(
    blocked.headers["access-control-allow-origin"],
    origin,
    "the browser can read the 429"
  );
};

(async () => {
  assert.deepEqual(RATE_LIMITS, {
    login: { windowMs: 15 * 60 * 1000, limit: 10 },
    enquiry: { windowMs: 60 * 60 * 1000, limit: 5 },
    api: { windowMs: 15 * 60 * 1000, limit: 300 },
  });

  // Login: 10 per 15 minutes per IP (empty bodies, so the lockout is not involved).
  const login = { method: "POST", url: "/api/auth/login", body: {}, ip: "30.0.0.1" };
  await expectLimit(login, {
    limit: 10,
    status: 400,
    message: "Too many login attempts. Please try again later.",
    windowSeconds: 900,
  });
  assert.equal((await dispatch(app, { ...login, ip: "30.0.0.2" })).status, 400, "per IP");
  // Letter case or a trailing slash does not get around it.
  for (const url of ["/api/auth/login/", "/API/Auth/Login"]) {
    assert.equal((await dispatch(app, { ...login, url })).status, 429, url);
  }

  // Enquiry placeholder: 501 until step 14, 5 per hour per IP.
  const enquiry = { method: "POST", url: "/api/enquiries", body: {}, ip: "31.0.0.1" };
  const first = await dispatch(app, { ...enquiry, ip: "31.0.0.9" });
  assert.deepEqual([first.status, first.body], [501, { message: "Not available yet." }]);
  await expectLimit(enquiry, {
    limit: 5,
    status: 501,
    message: "Too many enquiries. Please try again later.",
    windowSeconds: 3600,
  });
  assert.equal((await dispatch(app, { ...enquiry, ip: "31.0.0.2" })).status, 501, "per IP");

  // General API: 300 per 15 minutes per IP (401 here: no token).
  const api = { url: "/api/employees", ip: "32.0.0.1" };
  await expectLimit(api, {
    limit: 300,
    status: 401,
    message: "Too many requests. Please try again later.",
    windowSeconds: 900,
  });
  assert.equal((await dispatch(app, { ...api, url: "/api/stock" })).status, 429, "all /api");
  assert.equal((await dispatch(app, { ...api, ip: "32.0.0.2" })).status, 401, "per IP");

  // Health and the root page are never limited.
  for (let count = 0; count < 5; count += 1) {
    const health = await dispatch(app, { url: "/api/health", ip: "32.0.0.1" });
    assert.equal(health.status, 200);
    assert.equal(health.headers["ratelimit-limit"], undefined);
  }
  assert.equal((await dispatch(app, { url: "/", ip: "32.0.0.1" })).status, 200);

  // Only the last forwarded address counts (one trusted proxy), so a client
  // cannot get a new allowance by adding a made-up address in front.
  const spoofed = await dispatch(app, { ...api, ip: "99.99.99.99, 32.0.0.1" });
  assert.equal(spoofed.status, 429);

  assert.deepEqual(errors, [], "express-rate-limit reports no configuration warnings");

  console.error = originalError;
  process.stdout.write("Rate limits: all assertions passed.\n");
})().catch((err) => {
  console.error = originalError;
  console.error(err);
  process.exit(1);
});
