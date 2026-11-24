const mongoose = require("mongoose");

/*
 * A permanent payment against one estimate. Never deleted or edited:
 * corrections are made by voiding (the record stays, with void details)
 * and recording a new payment. Estimate balances never mix with invoices.
 */
const estimatePaymentSchema = new mongoose.Schema(
  {
    estimate: { type: mongoose.Schema.Types.ObjectId, ref: "Estimate", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    estimateNumber: { type: String, required: true, trim: true },

    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Payment amount must be whole paise greater than zero.",
      },
    },
    paymentDate: { type: Date, required: true },
    method: {
      type: String,
      required: true,
      enum: ["cash", "upi", "bank_transfer", "cheque", "other"],
    },
    reference: { type: String, default: "", trim: true, maxlength: 150 },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
    createdBy: { type: String, default: "Admin" },

    voided: { type: Boolean, default: false },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: String, default: "" },
    voidReason: { type: String, default: "", trim: true, maxlength: 250 },
  },
  { timestamps: true }
);

estimatePaymentSchema.index({ estimate: 1, paymentDate: -1, createdAt: -1 });
estimatePaymentSchema.index({ customer: 1, voided: 1 });

module.exports = mongoose.model("EstimatePayment", estimatePaymentSchema);
