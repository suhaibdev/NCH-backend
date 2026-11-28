const mongoose = require("mongoose");

/*
 * Failed-login counters for the lockout (utils/loginLockout.js). One document
 * per account or per IP, for each login type. MongoDB removes a document once
 * its window and any lock are over (TTL index on expiresAt).
 */
const loginAttemptSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    failures: { type: Number, default: 0 },
    windowStartedAt: { type: Date },
    lockedUntil: { type: Date, default: null },
    expiresAt: { type: Date },
  },
  { versionKey: false }
);

loginAttemptSchema.index({ key: 1 }, { unique: true });
loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("LoginAttempt", loginAttemptSchema);
