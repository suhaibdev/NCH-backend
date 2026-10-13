const mongoose = require("mongoose");
const washerAdvanceSchema = new mongoose.Schema({
  washer: { type: mongoose.Schema.Types.ObjectId, ref: "Washer", required: true },
  washerName: { type: String, required: true, trim: true },
  amountPaise: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  recoveredPaise: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  advanceDate: { type: Date, required: true },
  method: { type: String, required: true, enum: ["cash", "bank_transfer", "upi", "cheque", "other"] },
  reference: { type: String, default: "", trim: true, maxlength: 150 },
  notes: { type: String, default: "", trim: true, maxlength: 500 },
  createdBy: { type: String, default: "Admin" },
}, { timestamps: true });
washerAdvanceSchema.index({ washer: 1, advanceDate: -1, createdAt: -1 });
module.exports = mongoose.model("WasherAdvance", washerAdvanceSchema);
