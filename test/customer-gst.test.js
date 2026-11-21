/*
 * GST helpers (no DB): GSTIN, state codes, GST rates, HSN and the
 * Finished-Goods-only tax metadata rule.
 */
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const StockItem = require("../src/models/StockItem");
const {
  DEFAULT_GST_RATE_PERCENT,
  GST_RATE_PERCENTS,
  NCH_STATE_CODE,
  getStateName,
  isValidGstRate,
  isValidGstin,
  isValidStateCode,
  stateCodeFromGstin,
  validateHsnCode,
  validateTaxMetadata,
} = require("../src/utils/gst");

const UP_GSTIN = "09AAACH7409R1ZZ";
const MH_GSTIN = "27AAPFU0939F1ZV";

// GSTIN structure
assert.equal(isValidGstin(UP_GSTIN), true);
assert.equal(isValidGstin(MH_GSTIN), true);
assert.equal(isValidGstin(UP_GSTIN.toLowerCase()), false, "lowercase is not normalized here");
assert.equal(isValidGstin("09AAACH7409R1Z"), false, "14 chars");
assert.equal(isValidGstin("09AAACH7409R1AZ"), false, "14th char must be Z");
assert.equal(isValidGstin("25AAACH7409R1ZZ"), false, "retired state prefix");
assert.equal(isValidGstin("99AAACH7409R1ZZ"), false, "centre jurisdiction not accepted");
assert.equal(isValidGstin(""), false);
assert.equal(isValidGstin(null), false);

// GSTIN -> state code
assert.equal(stateCodeFromGstin(UP_GSTIN), "09");
assert.equal(stateCodeFromGstin(UP_GSTIN), NCH_STATE_CODE);
assert.equal(stateCodeFromGstin(MH_GSTIN), "27");
assert.equal(stateCodeFromGstin("25AAACH7409R1ZZ"), "");
assert.equal(stateCodeFromGstin("bad"), "");
assert.equal(getStateName("09"), "Uttar Pradesh");
assert.equal(getStateName("00"), "");

// State code allow-list
["01", "09", "24", "26", "27", "29", "36", "37", "38", "97"].forEach((code) =>
  assert.equal(isValidStateCode(code), true, code)
);
["00", "25", "28", "39", "96", "99", "9", "009", 9, null, ""].forEach((code) =>
  assert.equal(isValidStateCode(code), false, String(code))
);

// GST rates
assert.deepEqual([...GST_RATE_PERCENTS], [0, 0.25, 3, 5, 18, 40]);
assert.equal(DEFAULT_GST_RATE_PERCENT, 5);
[0, 0.25, 3, 5, 18, 40].forEach((rate) => assert.equal(isValidGstRate(rate), true, String(rate)));
[12, 28, "5", -1, 1, null, undefined, NaN].forEach((rate) =>
  assert.equal(isValidGstRate(rate), false, String(rate))
);

// HSN code
assert.deepEqual(validateHsnCode(""), { valid: true, value: "" });
assert.deepEqual(validateHsnCode(undefined), { valid: true, value: "" });
assert.deepEqual(validateHsnCode("3005"), { valid: true, value: "3005" });
assert.deepEqual(validateHsnCode(" 30059040 "), { valid: true, value: "30059040" });
assert.deepEqual(validateHsnCode(300590), { valid: true, value: "300590" });
["300", "300590401", "30A5", "30.5", {}].forEach((value) =>
  assert.equal(validateHsnCode(value).valid, false, String(value))
);

// Tax metadata by category
assert.deepEqual(validateTaxMetadata({ category: "finished_goods" }), { valid: true, value: {} });
assert.deepEqual(
  validateTaxMetadata({ category: "finished_goods", hsnCode: "3005", gstRatePercent: 18 }),
  { valid: true, value: { hsnCode: "3005", gstRatePercent: 18 } }
);
assert.deepEqual(
  validateTaxMetadata({ category: "finished_goods", gstRatePercent: "0.25" }),
  { valid: true, value: { gstRatePercent: 0.25 } }
);
assert.equal(validateTaxMetadata({ category: "finished_goods", gstRatePercent: 12 }).valid, false);
assert.equal(validateTaxMetadata({ category: "finished_goods", hsnCode: "12" }).valid, false);
["raw_material", "washed_raw_material"].forEach((category) => {
  assert.equal(validateTaxMetadata({ category, hsnCode: "3005" }).valid, false, category);
  assert.equal(validateTaxMetadata({ category, gstRatePercent: 5 }).valid, false, category);
  assert.equal(validateTaxMetadata({ category, hsnCode: "", gstRatePercent: null }).valid, true, category);
  assert.deepEqual(validateTaxMetadata({ category }), { valid: true, value: {} });
});

// Schema-level guard on StockItem
const baseItem = {
  productName: "Crepe Bandage",
  unit: "pcs",
};
const fg = new StockItem({ ...baseItem, category: "finished_goods", hsnCode: "3005", gstRatePercent: 5 });
assert.equal(fg.validateSync(), undefined);

const fgBadRate = new StockItem({ ...baseItem, category: "finished_goods", gstRatePercent: 12 });
assert.ok(fgBadRate.validateSync()?.errors?.gstRatePercent);

const fgBadHsn = new StockItem({ ...baseItem, category: "finished_goods", hsnCode: "12AB" });
assert.ok(fgBadHsn.validateSync()?.errors?.hsnCode);

const rawWithTax = new StockItem({
  ...baseItem,
  category: "raw_material",
  stockType: new mongoose.Types.ObjectId(),
  hsnCode: "3005",
  gstRatePercent: 5,
});
const rawErrors = rawWithTax.validateSync()?.errors || {};
assert.ok(rawErrors.hsnCode, "HSN rejected on raw material");
assert.ok(rawErrors.gstRatePercent, "GST rejected on raw material");

const rawPlain = new StockItem({ ...baseItem, category: "raw_material" }).toJSON();
assert.equal("hsnCode" in rawPlain, false, "no tax default on raw material");
assert.equal("gstRatePercent" in rawPlain, false, "no tax default on raw material");

console.log("Customer GST helpers: all assertions passed.");
