const mongoose = require("mongoose");

const washerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    normalizedName: { type: String, required: true, trim: true, lowercase: true, maxlength: 150 },
    phone: {
      type: String,
      default: "",
      maxlength: 10,
      validate: {
        validator: (value) => !value || /^\d{10}$/.test(value),
        message: "Contact number must be exactly 10 digits.",
      },
    },
    address: { type: String, default: "", trim: true, maxlength: 500 },
    defaultRatePerPiecePaise: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    washingRates: [{
      stockType: { type: mongoose.Schema.Types.ObjectId, ref: "StockType", required: true },
      stockTypeNameSnapshot: { type: String, required: true, trim: true },
      ratePerPiecePaise: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    }],
    notes: { type: String, default: "", trim: true, maxlength: 1000 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

washerSchema.pre("validate", function normalizeName(next) {
  if (this.name) {
    this.name = String(this.name).trim().replace(/\s+/g, " ");
    this.normalizedName = this.name.toLowerCase();
  }
  next();
});

washerSchema.index({ normalizedName: 1 }, { unique: true });
washerSchema.index({ isActive: 1, name: 1, _id: 1 });

module.exports = mongoose.model("Washer", washerSchema);
