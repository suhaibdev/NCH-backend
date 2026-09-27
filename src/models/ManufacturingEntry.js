const mongoose = require("mongoose");


/* ==========================================================
   MATERIAL USED IN PRODUCTION
========================================================== */

const manufacturingMaterialSchema =
  new mongoose.Schema(
    {
      item: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StockItem",
        required: true,
      },

      /*
       * Snapshots for permanent manufacturing
       * history.
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
        ],
      },

      unit: {
        type: String,
        required: true,
        enum: ["pcs", "dozen"],
      },

      /*
       * Total stock removed from inventory.
       *
       * IMPORTANT:
       * Wastage is INCLUDED inside this number.
       *
       * Example:
       * quantityUsed = 10
       * wastage = 2
       *
       * Stock deduction = 10, not 12.
       */
      quantityUsed: {
        type: Number,
        required: true,
        min: 1,

        validate: {
          validator: Number.isInteger,
          message:
            "Used quantity must be a whole number.",
        },
      },

      wastage: {
        type: Number,
        default: 0,
        min: 0,

        validate: {
          validator: Number.isInteger,
          message:
            "Wastage must be a whole number.",
        },
      },
    },
    {
      _id: false,
    }
  );


/* ==========================================================
   MANUFACTURING ENTRY
========================================================== */

const manufacturingEntrySchema =
  new mongoose.Schema(
    {
      finishedItem: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StockItem",
        required: true,
      },

      finishedProductName: {
        type: String,
        required: true,
        trim: true,
      },

      finishedUnit: {
        type: String,
        required: true,
        enum: ["pcs", "dozen"],
      },

      quantityManufactured: {
        type: Number,
        required: true,
        min: 1,

        validate: {
          validator: Number.isInteger,
          message:
            "Manufactured quantity must be a whole number.",
        },
      },

      materials: {
        type: [
          manufacturingMaterialSchema,
        ],

        validate: {
          validator(value) {
            return (
              Array.isArray(value) &&
              value.length > 0
            );
          },

          message:
            "At least one raw or washed material is required.",
        },
      },

      manufacturingDate: {
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


      /* ====================================================
         REVERSAL
      ==================================================== */

      reversed: {
        type: Boolean,
        default: false,
      },

      reversedAt: {
        type: Date,
        default: null,
      },

      reverseReason: {
        type: String,
        default: "",
        trim: true,
        maxlength: 500,
      },

      reversedBy: {
        type: String,
        default: "",
      },
    },
    {
      timestamps: true,
    }
  );


manufacturingEntrySchema.index({
  manufacturingDate: -1,
});

manufacturingEntrySchema.index({
  finishedItem: 1,
  manufacturingDate: -1,
});


module.exports =
  mongoose.model(
    "ManufacturingEntry",
    manufacturingEntrySchema
  );