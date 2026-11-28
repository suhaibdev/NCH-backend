const AuditLog = require("../models/AuditLog");

const MAX_DETAILS_LENGTH = 2000;
const SENSITIVE_KEY = /pass|token|secret|authorization|otp/i;

const text = (value, maximum) =>
  value === undefined || value === null ? "" : String(value).slice(0, maximum);

/** Small plain data only: secrets are redacted and large values are dropped. */
const cleanDetails = (details) => {
  if (details === undefined || details === null) return null;
  const json = JSON.stringify(details, (key, value) =>
    key && SENSITIVE_KEY.test(key) ? "[redacted]" : value
  );
  if (json === undefined) return null;
  if (json.length > MAX_DETAILS_LENGTH) return { truncated: true };
  return JSON.parse(json);
};

/**
 * Writes one audit record. Always await it.
 *
 * Default (failClosed false): a failed write is logged and the caller carries
 * on. Right for logins.
 *
 * failClosed true: a failed write throws, so the caller can stop. Use it for
 * money and security events.
 *
 * session: writes inside the caller's transaction. A failure then ALWAYS
 * throws, because MongoDB has already spoiled that transaction and
 * withTransaction needs the error to abort or retry. Await it in sequence with
 * the other operations on the session.
 *
 * To make an event fail closed for real, pass the session. Without it, a
 * throw cannot undo changes that were already committed.
 */
const recordAudit = async ({
  req,
  actor = req?.user?.id || null,
  role = req?.user?.role || "",
  identifier = "",
  action,
  recordType = "",
  recordId = "",
  details = null,
  session = null,
  failClosed = false,
} = {}) => {
  try {
    const entry = {
      actor: actor || null,
      actorRole: text(role, 40),
      identifier: text(identifier, 254),
      action: text(action, 80),
      recordType: text(recordType, 60),
      recordId: text(recordId, 60),
      details: cleanDetails(details),
      ip: text(req?.ip, 64),
    };
    if (session) {
      const [created] = await AuditLog.create([entry], { session });
      return created;
    }
    return await AuditLog.create(entry);
  } catch (error) {
    if (failClosed || session) throw error;
    console.error(`Audit log write failed (${text(action, 80)}):`, error.message);
    return null;
  }
};

module.exports = { MAX_DETAILS_LENGTH, cleanDetails, recordAudit };
