const mongoose = require("mongoose");

/*
 * A new, isolated identity lock prevents simultaneous first receipts from
 * creating two matching supplier-tracked StockItems. It does not impose a
 * unique index on legacy StockItem data.
 */
const stockIdentityLockSchema = new mongoose.Schema(
  {
    identityKey: { type: String, required: true, unique: true, immutable: true },
    stockItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StockIdentityLock", stockIdentityLockSchema);
