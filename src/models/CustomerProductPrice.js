const mongoose = require("mongoose");
const { MAX_PRICE_PAISE } = require("../utils/customerPricing");

/*
 * The current price of one Finished Goods item for one customer, in integer
 * paise per the item's stock unit. This row is mutable: future Estimates and
 * Invoices must copy the price (and product/tax details) into their own lines,
 * so changing a price here never alters an existing document.
 */
const customerProductPriceSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },

    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
      required: true,
    },

    pricePaise: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_PRICE_PAISE,
      validate: {
        validator: Number.isSafeInteger,
        message: "Price must be a whole number of paise.",
      },
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

customerProductPriceSchema.index({ customer: 1, item: 1 }, { unique: true });
customerProductPriceSchema.index({ item: 1 });

module.exports = mongoose.model("CustomerProductPrice", customerProductPriceSchema);
