const mongoose = require("mongoose");
const schema = new mongoose.Schema({ year: { type: Number, required: true, unique: true }, sequence: { type: Number, default: 0, min: 0 } }, { timestamps: true });
module.exports = mongoose.model("WasherPayoutCounter", schema);
