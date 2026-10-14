const mongoose = require("mongoose");

/* ==========================================================
   MATERIAL USED IN PRODUCTION
========================================================== */

const manufacturingMaterialSchema = new mongoose.Schema(
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

    stockType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockType",
      default: null,
    },

    stockTypeName: {
      type: String,
      default: "",
      trim: true,
    },

    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },

    supplierName: {
      type: String,
      default: "",
      trim: true,
    },

    size: {
      lengthValue: { type: Number, default: null },
      lengthUnit: { type: String, default: null },
      widthValue: { type: Number, default: null },
      widthUnit: { type: String, default: null },
    },

    category: {
      type: String,
      required: true,
      enum: ["raw_material", "washed_raw_material"],
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
        message: "Used quantity must be a whole number.",
      },
    },

    wastage: {
      type: Number,
      default: 0,
      min: 0,

      validate: {
        validator: Number.isInteger,
        message: "Wastage must be a whole number.",
      },
    },
  },
  {
    _id: false,
  }
);

const manufacturingOutputSchema = new mongoose.Schema(
  {
    finishedStockItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
      required: true,
    },
    finishedStockItemName: {
      type: String,
      required: true,
      trim: true,
    },
    stockType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockType",
      default: null,
    },
    stockTypeName: {
      type: String,
      default: "",
      trim: true,
    },
    unit: {
      type: String,
      required: true,
      enum: ["pcs", "dozen"],
    },
    quantityProduced: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "Produced quantity must be a whole number.",
      },
    },
  },
  { _id: false }
);

/* ==========================================================
   MANUFACTURING ENTRY
========================================================== */

const manufacturingEntrySchema = new mongoose.Schema(
  {
    manufacturingNumber: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },

    // New entries require this through the Manufacturing route. A default keeps
    // pre-batch V1 history readable without a destructive historical migration.
    batchNumber: {
      type: String,
      default: "",
      trim: true,
      maxlength: 100,
    },

    normalizedBatchNumber: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      maxlength: 100,
    },

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
        message: "Manufactured quantity must be a whole number.",
      },
    },

    output: {
      type: manufacturingOutputSchema,
      required: true,
    },

    materials: {
      type: [manufacturingMaterialSchema],

      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0;
        },

        message: "At least one raw or washed material is required.",
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

    status: {
      type: String,
      enum: ["completed", "reversed"],
      default: "completed",
      required: true,
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
  normalizedBatchNumber: 1,
});

manufacturingEntrySchema.index(
  {
    manufacturingNumber: 1,
  },
  { unique: true }
);

manufacturingEntrySchema.index({
  finishedItem: 1,
  manufacturingDate: -1,
});

module.exports = mongoose.model("ManufacturingEntry", manufacturingEntrySchema);
