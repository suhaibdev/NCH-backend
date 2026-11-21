/*
 * Customer pricing helpers (no DB): rupees <-> paise, assignment rules and the
 * CustomerProductPrice schema.
 */
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const CustomerProductPrice = require("../src/models/CustomerProductPrice");
const {
  MAX_PRICE_PAISE,
  isAssignableItem,
  isValidPricePaise,
  paiseToRupeesString,
  parsePricePaise,
} = require("../src/utils/customerPricing");
const { parseRupeesToPaise } = require("../src/utils/supplierAccounting");

// Rupees -> paise
assert.deepEqual(parsePricePaise("125.5"), { valid: true, value: 12550 });
assert.deepEqual(parsePricePaise("125.50"), { valid: true, value: 12550 });
assert.deepEqual(parsePricePaise(" 42 "), { valid: true, value: 4200 });
assert.deepEqual(parsePricePaise("0.01"), { valid: true, value: 1 });
assert.deepEqual(parsePricePaise(19.99), { valid: true, value: 1999 });
assert.deepEqual(parsePricePaise("1000000"), { valid: true, value: MAX_PRICE_PAISE });
["0", "0.00", "-1", "1.234", "abc", "", null, undefined, "1e3", "1,000", {}, [], true].forEach((value) =>
  assert.equal(parsePricePaise(value).valid, false, JSON.stringify(value))
);
assert.equal(parsePricePaise("1000000.01").valid, false, "over the max");
assert.match(parsePricePaise("abc").message, /^Price/);
assert.equal(parsePricePaise(undefined).message, "Price is required.");

// The shared parser keeps its supplier payment wording by default.
assert.equal(parseRupeesToPaise("abc").message, "Payment amount is invalid.");
assert.equal(parseRupeesToPaise("0").message, "Payment amount must be greater than zero.");

// Paise -> rupees
assert.equal(paiseToRupeesString(12550), "125.50");
assert.equal(paiseToRupeesString(1), "0.01");
assert.equal(paiseToRupeesString(100), "1.00");
assert.equal(paiseToRupeesString(0), "0.00");
assert.equal(paiseToRupeesString(1.5), "");
assert.equal(paiseToRupeesString(-1), "");

// Round trip
[1, 99, 100, 12550, 99999, MAX_PRICE_PAISE].forEach((paise) =>
  assert.equal(parsePricePaise(paiseToRupeesString(paise)).value, paise, String(paise))
);

// Positive integer paise
assert.equal(isValidPricePaise(1), true);
assert.equal(isValidPricePaise(MAX_PRICE_PAISE), true);
[0, -5, 1.5, MAX_PRICE_PAISE + 1, "100", NaN].forEach((value) =>
  assert.equal(isValidPricePaise(value), false, String(value))
);

// Only Finished Goods can be assigned
assert.equal(isAssignableItem({ category: "finished_goods" }), true);
assert.equal(isAssignableItem({ category: "raw_material" }), false);
assert.equal(isAssignableItem({ category: "washed_raw_material" }), false);
assert.equal(isAssignableItem(null), false);

// Schema
const ids = { customer: new mongoose.Types.ObjectId(), item: new mongoose.Types.ObjectId() };
const good = new CustomerProductPrice({ ...ids, pricePaise: 12550 });
assert.equal(good.validateSync(), undefined);
assert.equal(good.isActive, true, "active by default");

[0, -1, 1.5, MAX_PRICE_PAISE + 1].forEach((pricePaise) =>
  assert.ok(
    new CustomerProductPrice({ ...ids, pricePaise }).validateSync()?.errors?.pricePaise,
    String(pricePaise)
  )
);
const missing = new CustomerProductPrice({}).validateSync()?.errors || {};
assert.ok(missing.customer && missing.item && missing.pricePaise, "refs and price required");

// Unique (customer, item) index is declared.
const unique = CustomerProductPrice.schema
  .indexes()
  .find(([fields, options]) => fields.customer === 1 && fields.item === 1 && options.unique);
assert.ok(unique, "unique customer+item index");

console.log("Customer pricing: all assertions passed.");
