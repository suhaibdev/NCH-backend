const mongoose = require("mongoose");

const washingEntrySchema =
  new mongoose.Schema(
    {
      rawItem: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StockItem",
        required: true,
      },

      washedItem: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StockItem",
        required: true,
      },

      /*
       * Same quantity leaves raw stock
       * and enters washed stock.
       */
      quantity: {
        type: Number,
        required: true,
        min: 1,

        validate: {
          validator: Number.isInteger,
          message:
            "Quantity must be a whole number.",
        },
      },

      unit: {
        type: String,
        required: true,
        enum: ["pcs", "dozen"],
      },

      washingDate: {
        type: Date,
        default: Date.now,
      },

      reason: {
        type: String,
        default: "",
        trim: true,
        maxlength: 250,
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
      },
    },
    {
      timestamps: true,
    }
  );

washingEntrySchema.index({
  washingDate: -1,
});

module.exports =
  mongoose.model(
    "WashingEntry",
    washingEntrySchema
  );