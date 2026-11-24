const mongoose = require("mongoose");

// One counter per financial year (April to March). Never shared with invoices or estimates.
const challanCounterSchema = new mongoose.Schema(
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

module.exports = mongoose.model("ChallanCounter", challanCounterSchema);
