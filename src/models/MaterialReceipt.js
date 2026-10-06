const mongoose = require("mongoose");

const sizeSchema = new mongoose.Schema(
  {
    lengthValue: { type: Number, required: true, min: 0 },
    lengthUnit: { type: String, required: true, enum: ["m", "cm", "inch", "ft"] },
    widthValue: { type: Number, required: true, min: 0 },
    widthUnit: { type: String, required: true, enum: ["m", "cm", "inch", "ft"] },
  },
  { _id: false }
);

const materialReceiptSchema = new mongoose.Schema(
  {
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    supplierName: { type: String, required: true, trim: true, maxlength: 150 },
    stockItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
      required: true,
    },
    stockType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockType",
      required: true,
    },
    stockTypeName: { type: String, required: true, trim: true, maxlength: 100 },
    category: {
      type: String,
      required: true,
      enum: ["raw_material", "washed_raw_material"],
    },
    materialCondition: {
      type: String,
      required: true,
      enum: ["not_washed", "already_washed"],
    },
    size: { type: sizeSchema, required: true },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "Quantity must be a whole number.",
      },
    },
    unit: { type: String, required: true, enum: ["pcs"] },
    pricePerPiecePaise: { type: Number, required: true, min: 0 },
    totalAmountPaise: { type: Number, required: true, min: 0 },
    receivedDate: { type: Date, required: true },
    supplierBillNumber: { type: String, default: "", trim: true, maxlength: 150 },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
    createdBy: { type: String, default: "Admin", trim: true, maxlength: 100 },
  },
  { timestamps: true }
);

materialReceiptSchema.index({ supplier: 1, receivedDate: -1, createdAt: -1 });
materialReceiptSchema.index({ stockItem: 1, receivedDate: -1 });

module.exports = mongoose.model("MaterialReceipt", materialReceiptSchema);
