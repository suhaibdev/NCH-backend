const mongoose = require("mongoose");
const { GST_RATE_PERCENTS, HSN_PATTERN } = require("../utils/gst");

const integerValidator = {
  validator: Number.isInteger,
  message: "Quantity must be a whole number.",
};

/*
 * Tax metadata is allowed only on Finished Goods. In update-query context
 * (no document) only the value format is checked; routes check the category.
 */
const isFinishedGoodsContext = (context) =>
  !(context instanceof mongoose.Document) ||
  context.category === "finished_goods";

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

    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },

    size: {
      lengthValue: {
        type: Number,
        min: 0,
        default: null,
      },
      lengthUnit: {
        type: String,
        enum: ["m", "cm", "inch", "ft", null],
        default: null,
      },
      widthValue: {
        type: Number,
        min: 0,
        default: null,
      },
      widthUnit: {
        type: String,
        enum: ["m", "cm", "inch", "ft", null],
        default: null,
      },
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

    /*
     * Finished Goods tax metadata (not a price). No schema default so other
     * categories never carry these fields; a missing GST rate means 5%.
     */
    hsnCode: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          if (value === "") return true;
          return isFinishedGoodsContext(this) && HSN_PATTERN.test(value);
        },
        message: "HSN code must be 4 to 8 digits and is allowed only for Finished Goods.",
      },
    },

    gstRatePercent: {
      type: Number,
      validate: {
        validator: function (value) {
          return isFinishedGoodsContext(this) && GST_RATE_PERCENTS.includes(value);
        },
        message: "GST rate is not allowed for this item.",
      },
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

stockItemSchema.index({
  category: 1,
  stockType: 1,
  supplier: 1,
  "size.lengthValue": 1,
  "size.lengthUnit": 1,
  "size.widthValue": 1,
  "size.widthUnit": 1,
  unit: 1,
});

/*
 * Supports the Stock Type page filter, type product counts and delete guard.
 */
stockItemSchema.index({
  stockType: 1,
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
