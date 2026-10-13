const assert = require("assert");
const washing = require("../src/utils/washing");

const validSize = { lengthValue: 10, lengthUnit: "m", widthValue: 90, widthUnit: "cm" };

assert.deepStrictEqual(washing.parsePositiveInteger("8"), { valid: true, value: 8 });
assert.strictEqual(washing.parsePositiveInteger("0").valid, false);
assert.strictEqual(washing.parsePositiveInteger("2.5").valid, false);
assert.deepStrictEqual(washing.parseMoneyToPaise("12.50"), { valid: true, value: 1250 });
assert.deepStrictEqual(washing.parseMoneyToPaise("0"), { valid: true, value: 0 });
assert.strictEqual(washing.parseMoneyToPaise("12.345").valid, false);
assert.strictEqual(washing.parseMoneyToPaise("-1").valid, false);
assert.strictEqual(washing.parseDateOnly("2026-02-28").valid, true);
assert.strictEqual(washing.parseDateOnly("2026-02-30").valid, false);
assert.strictEqual(washing.hasCompleteSize(validSize), true);
assert.strictEqual(washing.hasCompleteSize({ ...validSize, widthUnit: "yard" }), false);
assert.strictEqual(washing.calculateChargePaise(8, 1250), 10000);
assert.strictEqual(washing.calculateChargePaise(1, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
assert.strictEqual(washing.calculateChargePaise(2, Number.MAX_SAFE_INTEGER), null);
const identity = { category: "washed_raw_material", stockType: "type", supplier: "supplier", size: validSize, unit: "pcs" };
assert.deepStrictEqual(washing.makeIdentityQuery(identity), { category: "washed_raw_material", stockType: "type", supplier: "supplier", "size.lengthValue": 10, "size.lengthUnit": "m", "size.widthValue": 90, "size.widthUnit": "cm", unit: "pcs" });
assert.strictEqual(washing.makeIdentityKey(identity), washing.makeIdentityKey(identity));

console.log("washing validation helpers: 15 cases passed");
