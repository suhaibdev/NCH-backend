/* sendServerError returns safe text and logs the real error server-side (no DB). */
const assert = require("node:assert/strict");
const { GENERIC_ERROR_MESSAGE, sendServerError } = require("../src/utils/httpErrors");

const makeRes = () => ({
  statusCode: null,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const logged = [];
const originalConsoleError = console.error;
console.error = (...args) => logged.push(args);
try {
  const secret = new Error('E11000 duplicate key { email: "a@b.c" } at mongodb://user:pw@host');

  let res = makeRes();
  sendServerError(res, "GET THING", secret);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: GENERIC_ERROR_MESSAGE });
  assert.equal(GENERIC_ERROR_MESSAGE, "Something went wrong. Please try again.");
  assert.ok(!JSON.stringify(res.body).includes("E11000"), "raw error text never reaches the client");
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "GET THING ERROR:");
  assert.equal(logged[0][1], secret, "the real error is logged server-side");

  res = makeRes();
  sendServerError(res, "CREATE THING", secret, "Unable to create thing.");
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: "Unable to create thing." });
} finally {
  console.error = originalConsoleError;
}

console.log("Error responses: all assertions passed.");
