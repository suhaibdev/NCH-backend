const mongoose = require("mongoose");

/*
 * A permanent payment against one invoice. Never deleted or edited:
 * corrections are made by voiding (the record stays, with void details)
 * and recording a new payment. Invoice balances never mix with estimates.
 */
const invoicePaymentSchema = new mongoose.Schema(
  {
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    invoiceNumber: { type: String, required: true, trim: true },

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

    // Set when this payment was carried over from an estimate payment (Step 11D).
    carriedFromEstimatePayment: { type: mongoose.Schema.Types.ObjectId, default: null },
    carriedFromEstimateNumber: { type: String, default: "" },
  },
  { timestamps: true }
);

invoicePaymentSchema.index({ invoice: 1, paymentDate: -1, createdAt: -1 });
invoicePaymentSchema.index({ customer: 1, voided: 1 });
// An estimate payment can be carried over at most once.
invoicePaymentSchema.index(
  { carriedFromEstimatePayment: 1 },
  { unique: true, partialFilterExpression: { carriedFromEstimatePayment: { $type: "objectId" } } }
);

module.exports = mongoose.model("InvoicePayment", invoicePaymentSchema);
