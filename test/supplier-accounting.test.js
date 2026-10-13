const assert = require("node:assert/strict");
const {
  calculateOutstandingPaise,
  canRecordPayment,
  parseDateOnly,
  parseRupeesToPaise,
} = require("../src/utils/supplierAccounting");

assert.equal(calculateOutstandingPaise(0, 0), 0);
assert.equal(calculateOutstandingPaise(1000000, 0), 1000000);
assert.equal(calculateOutstandingPaise(1000000, 400000), 600000);
assert.equal(canRecordPayment(1000000, 1000000), true);
assert.equal(canRecordPayment(1000000, 500000), true);
assert.equal(canRecordPayment(1000000, 1000001), false);
assert.equal(canRecordPayment(0, 1), false);
assert.equal(canRecordPayment(1000000, 0), false);
assert.equal(canRecordPayment(1000000, -1), false);
assert.deepEqual(parseRupeesToPaise("100.50"), { valid: true, value: 10050 });
assert.equal(parseRupeesToPaise("-1").valid, false);
assert.equal(parseDateOnly("2026-02-30").valid, false);
assert.equal(parseDateOnly("2026-02-28").valid, true);

console.log("Supplier accounting calculations passed.");
