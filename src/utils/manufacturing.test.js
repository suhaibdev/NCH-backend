const assert = require("assert");
const ManufacturingEntry = require("../models/ManufacturingEntry");
const {
  canReverseManufacturing,
  canReverseFinishedOutput,
  cleanBatchNumber,
  hasSufficientStock,
  hasValidLabelUsage,
  isAllowedInputCategory,
  isFinishedGoodsCategory,
  validateManufacturingPayload,
} = require("./manufacturing");

const validPayload = {
  manufacturingDate: "2026-10-13",
  batchNumber: " BATCH-100 ",
  notes: "Manual production entry",
  inputs: [
    { stockItem: "507f1f77bcf86cd799439011", quantityUsed: 10, wastage: 2 },
    { stockItem: "507f1f77bcf86cd799439012", quantityUsed: 4, wastage: 0 },
  ],
  output: { finishedStockItem: "507f1f77bcf86cd799439013", quantityProduced: 8 },
};

assert.equal(
  validateManufacturingPayload(validPayload).valid,
  true,
  "multiple valid inputs are accepted"
);
assert.equal(
  validateManufacturingPayload(validPayload).value.batchNumber,
  "BATCH-100",
  "Batch No. is trimmed and saved"
);
assert.equal(
  validateManufacturingPayload({ ...validPayload, batchNumber: "   " }).valid,
  false,
  "blank Batch No. is rejected"
);
assert.equal(
  cleanBatchNumber(" Batch 100 ").normalizedValue,
  "batch 100",
  "Batch duplicate comparisons use normalized surrounding whitespace"
);
assert.equal(isAllowedInputCategory("raw_material"), true, "Raw Material is an allowed input");
assert.equal(
  isAllowedInputCategory("washed_raw_material"),
  true,
  "Washed Raw Material is an allowed input"
);
assert.equal(isAllowedInputCategory("finished_goods"), false, "Finished Goods cannot be an input");
assert.equal(
  isFinishedGoodsCategory("finished_goods"),
  true,
  "Finished Goods is an allowed output"
);
assert.equal(isFinishedGoodsCategory("raw_material"), false, "Raw Material cannot be an output");
assert.equal(hasSufficientStock(10, 10), true, "quantity used is the only stock deduction");
assert.equal(hasSufficientStock(9, 10), false, "insufficient input stock is rejected");
assert.equal(canReverseFinishedOutput(8, 8), true, "available finished output can be reversed");
assert.equal(canReverseFinishedOutput(7, 8), false, "insufficient finished output blocks reversal");
assert.equal(canReverseManufacturing("completed"), true, "completed entry can be reversed once");
assert.equal(canReverseManufacturing("reversed"), false, "second reversal is rejected");
assert.equal(
  hasValidLabelUsage({ quantityUsed: 100, wastage: 0 }, 100),
  true,
  "Label Quantity Used matches numeric Finished Quantity"
);
assert.equal(
  hasValidLabelUsage({ quantityUsed: 100, wastage: 0 }, 125),
  false,
  "changing Finished Quantity requires the same numeric Label quantity"
);
assert.equal(
  hasValidLabelUsage({ quantityUsed: 100, wastage: 1 }, 100),
  false,
  "Label wastage must remain zero"
);
assert.equal(
  validateManufacturingPayload({
    ...validPayload,
    inputs: [{ ...validPayload.inputs[0], wastage: 11 }],
  }).valid,
  false,
  "wastage cannot exceed quantity used"
);
assert.equal(
  validateManufacturingPayload({
    ...validPayload,
    output: { ...validPayload.output, quantityProduced: 0 },
  }).valid,
  false,
  "output quantity must be positive"
);
assert.equal(
  validateManufacturingPayload({
    ...validPayload,
    inputs: [{ ...validPayload.inputs[0], quantityUsed: 0 }],
  }).valid,
  false,
  "quantity used must be positive"
);
assert.equal(
  validateManufacturingPayload({
    ...validPayload,
    inputs: [validPayload.inputs[0], validPayload.inputs[0]],
  }).valid,
  false,
  "the same input cannot be selected twice"
);

const snapshotEntry = new ManufacturingEntry({
  manufacturingNumber: "MF-2026-0001",
  batchNumber: "BATCH-100",
  normalizedBatchNumber: "batch-100",
  finishedItem: "507f1f77bcf86cd799439013",
  finishedProductName: "Finished Bandage",
  finishedUnit: "pcs",
  quantityManufactured: 8,
  output: {
    finishedStockItem: "507f1f77bcf86cd799439013",
    finishedStockItemName: "Finished Bandage",
    stockTypeName: "Bandage Roll",
    unit: "pcs",
    quantityProduced: 8,
  },
  materials: [
    {
      item: "507f1f77bcf86cd799439011",
      productName: "Bandage Cloth",
      category: "washed_raw_material",
      stockTypeName: "Washed Bandage Cloth",
      supplierName: "Supplier A",
      size: { lengthValue: 18, lengthUnit: "m", widthValue: 40, widthUnit: "inch" },
      unit: "pcs",
      quantityUsed: 10,
      wastage: 2,
    },
  ],
  manufacturingDate: new Date("2026-10-13T00:00:00.000Z"),
});

assert.equal(
  snapshotEntry.validateSync(),
  undefined,
  "manufacturing snapshots validate without live stock data"
);
assert.equal(
  snapshotEntry.materials[0].supplierName,
  "Supplier A",
  "supplier snapshot is preserved"
);
assert.equal(
  snapshotEntry.materials[0].size.lengthValue,
  18,
  "structured size snapshot is preserved"
);
assert.equal(
  snapshotEntry.output.finishedStockItemName,
  "Finished Bandage",
  "output snapshot is preserved"
);
assert.equal(snapshotEntry.batchNumber, "BATCH-100", "Batch No. snapshot is preserved");

console.log("Manufacturing helper tests passed.");
