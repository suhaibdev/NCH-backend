const mongoose = require("mongoose");

// One counter per financial year (April to March). Never shared with estimates or challans.
const invoiceCounterSchema = new mongoose.Schema(
  {
    financialYear: {
      type: String,
      required: true,
      unique: true,
      match: /^\d{4}-\d{2}$/,
    },
    sequence: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("InvoiceCounter", invoiceCounterSchema);
