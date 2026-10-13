const mongoose = require("mongoose");
const lineSchema = new mongoose.Schema({ process: { type: mongoose.Schema.Types.ObjectId, ref: "WashingProcess", required: true }, outputTypeName: { type: String, required: true }, quantity: { type: Number, required: true }, ratePerPiecePaise: { type: Number, required: true }, amountPaise: { type: Number, required: true } }, { _id: false });
const recoverySchema = new mongoose.Schema({ advance: { type: mongoose.Schema.Types.ObjectId, ref: "WasherAdvance", required: true }, amountPaise: { type: Number, required: true, min: 1 } }, { _id: false });
const schema = new mongoose.Schema({
  payoutNumber: { type: String, required: true, unique: true }, washer: { type: mongoose.Schema.Types.ObjectId, ref: "Washer", required: true }, washerName: { type: String, required: true },
  periodStart: { type: Date, required: true }, periodEnd: { type: Date, required: true }, washingProcesses: [{ type: mongoose.Schema.Types.ObjectId, ref: "WashingProcess", required: true }], lines: [lineSchema],
  grossEarningsPaise: { type: Number, required: true }, outstandingAdvanceBeforePaise: { type: Number, required: true }, advanceDeductionPaise: { type: Number, required: true }, outstandingAdvanceAfterPaise: { type: Number, required: true }, advanceRecoveries: [recoverySchema], netPaidPaise: { type: Number, required: true },
  payoutDate: { type: Date, required: true }, paymentMethod: { type: String, required: true, enum: ["cash", "bank_transfer", "upi", "cheque", "other"] }, paymentReference: { type: String, default: "", maxlength: 150 }, status: { type: String, enum: ["paid"], default: "paid" }, createdBy: { type: String, default: "Admin" },
}, { timestamps: true });
schema.index({ washer: 1, payoutDate: -1, _id: -1 });
module.exports = mongoose.model("WasherPayout", schema);
