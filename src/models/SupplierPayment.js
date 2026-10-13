const mongoose = require("mongoose");

const supplierPaymentSchema = new mongoose.Schema(
  {
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    supplierName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Payment amount must be a whole paise amount greater than zero.",
      },
    },
    paymentDate: {
      type: Date,
      required: true,
    },
    method: {
      type: String,
      required: true,
      enum: ["cash", "bank_transfer", "upi", "cheque", "other"],
    },
    reference: {
      type: String,
      default: "",
      trim: true,
      maxlength: 150,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    createdBy: {
      type: String,
      default: "Admin",
      trim: true,
      maxlength: 100,
    },
  },
  { timestamps: true }
);

supplierPaymentSchema.index({ supplier: 1, paymentDate: -1, createdAt: -1 });

module.exports = mongoose.model("SupplierPayment", supplierPaymentSchema);
