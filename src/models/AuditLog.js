const mongoose = require("mongoose");

/*
 * Audit trail. APPEND-ONLY and kept forever: records can be created and read,
 * never changed or removed. The hooks below refuse every Mongoose update,
 * replace and delete. There is no TTL index.
 */
const APPEND_ONLY_MESSAGE = "AuditLog is append-only: records cannot be changed or deleted.";

const auditLogSchema = new mongoose.Schema(
  {
    // Who: the user id when known (null for a failed or locked login).
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, default: "", maxlength: 40 },
    // Login identifier as typed (never a password).
    identifier: { type: String, default: "", maxlength: 254 },
    action: { type: String, required: true, maxlength: 80 },
    recordType: { type: String, default: "", maxlength: 60 },
    recordId: { type: String, default: "", maxlength: 60 },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: "", maxlength: 64 },
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false, minimize: false }
);

auditLogSchema.index({ createdAt: -1, _id: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ recordType: 1, createdAt: -1 });

const refuse = function refuseChange(next) {
  next(new Error(APPEND_ONLY_MESSAGE));
};

[
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteMany",
  "findOneAndDelete",
  "findOneAndRemove",
].forEach((operation) => auditLogSchema.pre(operation, refuse));

// deleteOne exists on both the query and the document.
auditLogSchema.pre("deleteOne", { document: false, query: true }, refuse);
auditLogSchema.pre("deleteOne", { document: true, query: false }, refuse);

auditLogSchema.pre("save", function refuseResave(next) {
  if (!this.isNew) return next(new Error(APPEND_ONLY_MESSAGE));
  return next();
});

// bulkWrite skips query middleware, so it is replaced outright.
auditLogSchema.statics.bulkWrite = async function refuseBulkWrite() {
  throw new Error(APPEND_ONLY_MESSAGE);
};

const AuditLog = mongoose.model("AuditLog", auditLogSchema);
AuditLog.APPEND_ONLY_MESSAGE = APPEND_ONLY_MESSAGE;

module.exports = AuditLog;
