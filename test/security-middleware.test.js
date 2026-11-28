/*
 * CORS allow-list, security headers and the JSON body limit, on the real app.
 * No database, no port, no .env.
 */
const assert = require("node:assert/strict");
const path = require("path");
const { dispatch, loadApp, root } = require("./helpers/appHarness");

const express = require("express");
const cors = require("cors");

const { app, warnings } = loadApp({
  env: {
    JWT_SECRET: "security-test-only",
    NODE_ENV: "production",
    CORS_ALLOWED_ORIGINS: " https://app.example , https://admin.example/ ,*, https://*.evil.test,",
  },
});
const {
  JSON_BODY_LIMIT,
  createCorsOptions,
  createSecurityHeaders,
  parseAllowedOrigins,
} = require(path.join(root, "src/middleware/security"));
console.log = () => {};
console.error = ((original) => (...args) => {
  if (!String(args[0]).includes("PayloadTooLargeError")) original(...args);
})(console.error);

const miniApp = (...middleware) => {
  const mini = express();
  mini.disable("x-powered-by");
  mini.use(...middleware);
  mini.get("/", (req, res) => res.send("ok"));
  return mini;
};

(async () => {
  // Parsing.
  assert.deepEqual(parseAllowedOrigins(undefined), { origins: [], wildcardIgnored: false });
  assert.deepEqual(parseAllowedOrigins(""), { origins: [], wildcardIgnored: false });
  assert.deepEqual(parseAllowedOrigins("*"), { origins: [], wildcardIgnored: true });
  assert.deepEqual(parseAllowedOrigins("null"), { origins: [], wildcardIgnored: true });
  assert.deepEqual(parseAllowedOrigins("https://a.test/, http://localhost:4000"), {
    origins: ["https://a.test", "http://localhost:4000"],
    wildcardIgnored: false,
  });
  assert.equal(warnings.length, 1, "the ignored wildcard is warned about");
  assert.match(warnings[0], /CORS_ALLOWED_ORIGINS/);
  assert.equal(warnings[0].includes("example"), false, "no values in the warning");

  const health = (headers, method = "GET") =>
    dispatch(app, { method, url: "/api/health", headers });
  const allowHeader = "access-control-allow-origin";

  // Allowed origins are echoed back exactly, never as a wildcard.
  for (const origin of ["https://app.example", "https://admin.example"]) {
    const response = await health({ origin });
    assert.equal(response.status, 200);
    assert.equal(response.headers[allowHeader], origin);
    assert.match(String(response.headers.vary), /Origin/);
  }

  // Everything else gets no CORS header, and is not an error.
  for (const origin of [
    "https://evil.test",
    "https://sub.evil.test",
    "http://app.example",
    "https://app.example.evil.test",
    "https://app.example:8443",
    "null",
    "*",
  ]) {
    const response = await health({ origin });
    assert.equal(response.status, 200, origin);
    assert.equal(response.headers[allowHeader], undefined, origin);
  }

  const noOrigin = await health({});
  assert.equal(noOrigin.status, 200, "requests without an Origin work as before");
  assert.equal(noOrigin.headers[allowHeader], undefined);

  // Preflight: allowed gets 204 with the header; disallowed gets no header.
  const preflight = (origin) =>
    dispatch(app, {
      method: "OPTIONS",
      url: "/api/employees",
      headers: {
        origin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
  const allowed = await preflight("https://app.example");
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers[allowHeader], "https://app.example");
  assert.match(String(allowed.headers["access-control-allow-headers"]), /authorization/);
  assert.equal((await preflight("https://evil.test")).headers[allowHeader], undefined);

  // An empty list allows no browser origin.
  const closed = await dispatch(miniApp(cors(createCorsOptions([]))), {
    url: "/",
    headers: { origin: "https://app.example" },
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.headers[allowHeader], undefined);

  // Helmet defaults, no x-powered-by, HSTS in production (this app).
  const headers = noOrigin.headers;
  assert.ok(headers["content-security-policy"]);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["cross-origin-resource-policy"], "same-origin");
  assert.ok(headers["cross-origin-opener-policy"]);
  assert.equal(headers["x-powered-by"], undefined);
  assert.match(String(headers["strict-transport-security"]), /^max-age=\d+/);

  // Errors and unknown routes carry the headers too.
  const missing = await dispatch(app, { url: "/nope" });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["x-powered-by"], undefined);
  assert.equal(missing.headers["x-content-type-options"], "nosniff");

  // No HSTS outside production; the other headers stay.
  const dev = await dispatch(miniApp(createSecurityHeaders({ isProduction: false })), {
    url: "/",
  });
  assert.equal(dev.headers["strict-transport-security"], undefined);
  assert.ok(dev.headers["content-security-policy"]);
  assert.equal(dev.headers["x-powered-by"], undefined);

  // JSON body limit.
  assert.equal(JSON_BODY_LIMIT, "100kb");
  const post = (size) =>
    dispatch(app, {
      method: "POST",
      url: "/api/enquiries",
      body: JSON.stringify({ message: "x".repeat(size) }),
      ip: "40.0.0.1",
    });
  assert.equal((await post(99 * 1024)).status, 501, "under the limit is parsed");
  assert.equal((await post(101 * 1024)).status, 413, "over the limit is refused");

  process.stdout.write("Security middleware: all assertions passed.\n");
})().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
