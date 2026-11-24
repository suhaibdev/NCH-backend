const mongoose = require("mongoose");

/*
 * Estimate: a non-GST sales document. No HSN or GST anywhere.
 * Stock is deducted at creation; every line keeps a price snapshot so later
 * customer price changes never alter an existing estimate.
 */

const safeInteger = (message) => ({ validator: Number.isSafeInteger, message });

const lineSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", required: true },
    productName: { type: String, required: true, trim: true, maxlength: 150 },
    unit: { type: String, required: true, enum: ["pcs", "dozen"] },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 100000,
      validate: safeInteger("Quantity must be a whole number."),
    },
    pricePaise: {
      type: Number,
      required: true,
      min: 1,
      validate: safeInteger("Price must be whole paise."),
    },
    lineTotalPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: safeInteger("Line total must be whole paise."),
    },
  },
  { _id: true }
);

const addressSnapshot = {
  line1: { type: String, default: "" },
  line2: { type: String, default: "" },
  city: { type: String, default: "" },
  pincode: { type: String, default: "" },
};

const estimateSchema = new mongoose.Schema(
  {
    estimateNumber: { type: String, required: true, trim: true },
    financialYear: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    sequence: { type: Number, required: true, min: 1 },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customerSnapshot: {
      name: { type: String, required: true },
      billingName: { type: String, default: "" },
      contactNumber: { type: String, default: "" },
      stateCode: { type: String, default: "" },
      billingAddress: addressSnapshot,
    },

    estimateDate: { type: Date, required: true },

    lines: {
      type: [lineSchema],
      validate: {
        validator: (lines) => Array.isArray(lines) && lines.length >= 1 && lines.length <= 100,
        message: "An estimate needs 1 to 100 lines.",
      },
    },

    totalPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: safeInteger("Total must be whole paise."),
    },

    // "converted" is reserved for invoice conversion (Step 11D); nothing sets it yet.
    status: {
      type: String,
      required: true,
      enum: ["active", "cancelled", "converted"],
      default: "active",
    },

    notes: { type: String, default: "", trim: true, maxlength: 500 },

    // Bumped by every edit, cancel, payment and void: serializes concurrent writes.
    revision: { type: Number, default: 0, min: 0 },

    createdBy: { type: String, default: "Admin" },
    updatedBy: { type: String, default: "Admin" },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancelReason: { type: String, default: "", trim: true, maxlength: 250 },

    // Reserved for Step 11D: link to the invoice without a second stock deduction.
    convertedInvoice: { type: mongoose.Schema.Types.ObjectId, default: null },
    convertedInvoiceNumber: { type: String, default: "" },
    convertedAt: { type: Date, default: null },
    convertedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

estimateSchema.index({ estimateNumber: 1 }, { unique: true });
estimateSchema.index({ customer: 1, estimateDate: -1, _id: -1 });
estimateSchema.index({ status: 1, estimateDate: -1, _id: -1 });
estimateSchema.index({ estimateDate: -1, _id: -1 });

module.exports = mongoose.model("Estimate", estimateSchema);
