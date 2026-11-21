/*
 * Stock list response shape (no DB).
 *
 * lean() drops the StockItem schema virtuals (id, isLowStock, quantityInPieces)
 * that toJSON includes. withStockVirtuals must restore them so GET /stock and
 * GET /stock/low-stock return the same JSON as before.
 */
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const StockItem = require("../src/models/StockItem");
const { withStockVirtuals } = require("../src/utils/listQuery");
const { buildStockSummaryPipeline } = require("../src/utils/stockSummary");

const base = () => ({
  _id: new mongoose.Types.ObjectId(),
  productName: "Cotton Roll",
  category: "raw_material",
  stockType: new mongoose.Types.ObjectId(),
  supplier: new mongoose.Types.ObjectId(),
  size: { lengthValue: 2, lengthUnit: "m", widthValue: 1, widthUnit: "m" },
  unit: "pcs",
  currentStock: 5,
  minimumStock: 10,
  notes: "n",
});

const cases = [
  base(),
  { ...base(), unit: "dozen", currentStock: 7, minimumStock: 7 },
  { ...base(), currentStock: 0, minimumStock: 0 },
  { ...base(), currentStock: 100, minimumStock: 3 },
];

cases.forEach((doc) => {
  const hydrated = new StockItem(doc).toJSON();
  // Simulate a lean document: stored fields only, plus timestamps and __v.
  const stored = {
    ...JSON.parse(JSON.stringify(doc)),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    __v: 0,
  };
  const rebuilt = JSON.parse(JSON.stringify(withStockVirtuals(stored)));
  const expected = JSON.parse(JSON.stringify(hydrated));

  // Compare only keys the hydrated doc produced (timestamps/__v are set on save).
  Object.keys(expected).forEach((key) => {
    assert.deepEqual(rebuilt[key], expected[key], `key ${key}`);
  });
  ["id", "isLowStock", "quantityInPieces"].forEach((key) =>
    assert.ok(key in rebuilt, `virtual ${key} present`)
  );
  assert.equal(
    Object.keys(rebuilt).filter((key) => !(key in expected) && !["createdAt", "updatedAt", "__v"].includes(key)).length,
    0,
    "no unexpected extra keys"
  );
});

assert.equal(withStockVirtuals(null), null);

// Summary pipeline: a single $group with the five counters, low stock needs numeric fields.
const [group] = buildStockSummaryPipeline();
assert.deepEqual(Object.keys(group.$group), [
  "_id", "totalItems", "rawMaterial", "washedRawMaterial", "finishedGoods", "lowStock",
]);
assert.equal(group.$group._id, null);
assert.deepEqual(group.$group.lowStock.$sum.$cond[0].$and[0], { $isNumber: "$currentStock" });

console.log("Stock list shape: all assertions passed.");
