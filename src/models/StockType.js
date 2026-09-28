const mongoose = require("mongoose");

const stockTypeSchema =
  new mongoose.Schema(
    {
      name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 100,
      },

      normalizedName: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
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


/* ==========================================================
   NORMALIZE NAME
========================================================== */

stockTypeSchema.pre(
  "validate",
  function (next) {
    if (this.name) {
      this.name =
        String(this.name)
          .trim()
          .replace(/\s+/g, " ");

      this.normalizedName =
        this.name.toLowerCase();
    }

    next();
  }
);


/* ==========================================================
   PREVENT DUPLICATE TYPE INSIDE SAME MAIN CATEGORY

   Example:
   Raw Material -> Label
   Raw Material -> label

   These are treated as the same Stock Type.
========================================================== */

stockTypeSchema.index(
  {
    category: 1,
    normalizedName: 1,
  },
  {
    unique: true,
  }
);


/* ==========================================================
   USEFUL SORT / FILTER INDEX
========================================================== */

stockTypeSchema.index({
  category: 1,
  name: 1,
});


module.exports =
  mongoose.model(
    "StockType",
    stockTypeSchema
  );