const mongoose = require("mongoose");

const integerValidator = {
  validator: Number.isInteger,
  message: "Quantity must be a whole number.",
};

const stockItemSchema = new mongoose.Schema(
  {
    productName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

    category: {
      type: String,
      required: true,
      enum: [
        "raw_material",
        "washed_raw_material",
        "finished_goods",
      ],
    },

    stockType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockType",
      default: null,
    },

    unit: {
      type: String,
      required: true,
      enum: ["pcs", "dozen"],
    },

    currentStock: {
      type: Number,
      default: 0,
      min: 0,
      validate: integerValidator,
    },

    minimumStock: {
      type: Number,
      default: 0,
      min: 0,
      validate: integerValidator,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
  },
  {
    timestamps: true,
  }
);

/*
 * Product names should not be duplicated accidentally.
 * The route will also perform a case-insensitive check.
 */
stockItemSchema.index({
  productName: 1,
});

/*
 * Useful for category stock screens.
 */
stockItemSchema.index({
  category: 1,
  productName: 1,
});

/*
 * Low-stock status is calculated automatically.
 */
stockItemSchema.virtual("isLowStock").get(
  function () {
    return (
      this.currentStock <=
      this.minimumStock
    );
  }
);

/*
 * Optional conversion information.
 *
 * We still STORE the product using its configured
 * unit only.
 *
 * Example:
 * 10 dozen remains 10 dozen in stock.
 * This merely lets the system know that it
 * represents 120 individual pieces.
 */
stockItemSchema.virtual(
  "quantityInPieces"
).get(function () {
  if (this.unit === "dozen") {
    return this.currentStock * 12;
  }

  return this.currentStock;
});

stockItemSchema.set("toJSON", {
  virtuals: true,
});

stockItemSchema.set("toObject", {
  virtuals: true,
});

module.exports = mongoose.model(
  "StockItem",
  stockItemSchema
);