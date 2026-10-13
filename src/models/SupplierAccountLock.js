const mongoose = require("mongoose");

// This is a transaction-only serialization record, not an editable balance.
const supplierAccountLockSchema = new mongoose.Schema(
  {
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
      unique: true,
    },
    revision: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SupplierAccountLock", supplierAccountLockSchema);
