/*
 * Per-IP rate limits, counted in memory. On a single instance (Render free
 * tier) the counts are exact while it runs, and every restart, deploy or
 * spin-down resets them. More than one instance would need a shared store.
 * Login lockouts are separate and stored in MongoDB.
 */
const { rateLimit } = require("express-rate-limit");

const MINUTE_MS = 60 * 1000;

const RATE_LIMITS = {
  login: { windowMs: 15 * MINUTE_MS, limit: 10 },
  enquiry: { windowMs: 60 * MINUTE_MS, limit: 5 },
  api: { windowMs: 15 * MINUTE_MS, limit: 300 },
};

const createLimiter = ({ windowMs, limit }, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-6",
    legacyHeaders: false,
    message: { success: false, message },
  });

const loginLimiter = createLimiter(
  RATE_LIMITS.login,
  "Too many login attempts. Please try again later."
);

const enquiryLimiter = createLimiter(
  RATE_LIMITS.enquiry,
  "Too many enquiries. Please try again later."
);

const apiLimiter = createLimiter(
  RATE_LIMITS.api,
  "Too many requests. Please try again later."
);

module.exports = { RATE_LIMITS, apiLimiter, enquiryLimiter, loginLimiter };
