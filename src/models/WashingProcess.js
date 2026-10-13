const mongoose = require("mongoose");

const sizeSchema = new mongoose.Schema(
  {
    lengthValue: { type: Number, required: true },
    lengthUnit: { type: String, required: true, enum: ["m", "cm", "inch", "ft"] },
    widthValue: { type: Number, required: true },
    widthUnit: { type: String, required: true, enum: ["m", "cm", "inch", "ft"] },
  },
  { _id: false }
);

const washingProcessSchema = new mongoose.Schema(
  {
    sourceStockItem: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", required: true },
    sourceStockType: { type: mongoose.Schema.Types.ObjectId, ref: "StockType", required: true },
    sourceStockTypeName: { type: String, required: true, trim: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    supplierName: { type: String, required: true, trim: true },
    size: { type: sizeSchema, required: true },
    unit: { type: String, required: true, enum: ["pcs"] },
    quantity: { type: Number, required: true, min: 1, validate: Number.isInteger },
    washer: { type: mongoose.Schema.Types.ObjectId, ref: "Washer", required: true },
    washerName: { type: String, required: true, trim: true },
    ratePerPiecePaise: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    estimatedChargePaise: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    earnedAmountPaise: { type: Number, default: null, min: 0, validate: (value) => value === null || Number.isSafeInteger(value) },
    status: { type: String, required: true, enum: ["in_process", "completed"], default: "in_process" },
    sentDate: { type: Date, required: true },
    completedDate: { type: Date, default: null },
    destinationStockItem: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", default: null },
    destinationStockType: { type: mongoose.Schema.Types.ObjectId, ref: "StockType", required: true },
    destinationStockTypeName: { type: String, required: true, trim: true },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
    createdBy: { type: String, default: "Admin" },
    completedBy: { type: String, default: "" },
    settlementStatus: { type: String, enum: ["unpaid", "paid"], default: "unpaid", required: true },
    washerPayout: { type: mongoose.Schema.Types.ObjectId, ref: "WasherPayout", default: null },
  },
  { timestamps: true }
);

washingProcessSchema.index({ status: 1, sentDate: -1, createdAt: -1, _id: -1 });
washingProcessSchema.index({ washer: 1, status: 1, sentDate: -1 });
washingProcessSchema.index({ washer: 1, status: 1, settlementStatus: 1, completedDate: 1, _id: 1 });

module.exports = mongoose.model("WashingProcess", washingProcessSchema);
