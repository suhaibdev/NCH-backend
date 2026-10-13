const mongoose = require("mongoose");

const manufacturingCounterSchema = new mongoose.Schema(
  {
    year: {
      type: Number,
      required: true,
      unique: true,
    },
    sequence: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ManufacturingCounter", manufacturingCounterSchema);
