const mongoose = require("mongoose");

const stockMovementSchema =
  new mongoose.Schema(
    {
      item: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StockItem",
        required: true,
      },

      /*
       * Snapshot values are saved so old history
       * still makes sense even if an item name
       * changes later.
       */
      productName: {
        type: String,
        required: true,
        trim: true,
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

      unit: {
        type: String,
        required: true,
        enum: ["pcs", "dozen"],
      },

      direction: {
        type: String,
        required: true,
        enum: ["in", "out"],
      },

      movementType: {
        type: String,
        required: true,
        enum: [
          "stock_in",
          "stock_out",

          "washing_out",
          "washing_in",

          "manufacturing_use",
          "manufacturing_output",

          "manufacturing_reverse_in",
          "manufacturing_reverse_out",

          "adjustment",
        ],
      },

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

      balanceBefore: {
        type: Number,
        required: true,
        min: 0,
      },

      balanceAfter: {
        type: Number,
        required: true,
        min: 0,
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

      /*
       * Lets us connect history with washing
       * or manufacturing records.
       */
      referenceType: {
        type: String,
        enum: [
          "",
          "washing",
          "manufacturing",
          "manual",
        ],
        default: "",
      },

      referenceId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
      },

      movementDate: {
        type: Date,
        default: Date.now,
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

stockMovementSchema.index({
  item: 1,
  movementDate: -1,
});

stockMovementSchema.index({
  movementType: 1,
  movementDate: -1,
});

module.exports =
  mongoose.model(
    "StockMovement",
    stockMovementSchema
  );