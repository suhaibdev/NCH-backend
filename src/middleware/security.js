const helmet = require("helmet");

/*
 * Limit for JSON bodies only. File uploads (logo, UPI QR) are not JSON and
 * will need their own limit when they are built.
 */
const JSON_BODY_LIMIT = "100kb";

/*
 * CORS_ALLOWED_ORIGINS is a comma-separated list of exact origins. Any entry
 * containing a wildcard is dropped, so a wildcard can never allow everything.
 */
const parseAllowedOrigins = (value) => {
  const origins = [];
  let wildcardIgnored = false;
  String(value || "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .forEach((entry) => {
      if (entry.includes("*") || entry.toLowerCase() === "null") {
        wildcardIgnored = true;
        return;
      }
      origins.push(entry);
    });
  return { origins, wildcardIgnored };
};

/*
 * A disallowed origin gets no CORS headers (the browser blocks it); it is not
 * an error. Requests without an Origin header work as before.
 */
const createCorsOptions = (origins) => {
  const allowed = new Set(origins);
  return {
    origin: (origin, callback) => callback(null, Boolean(origin) && allowed.has(origin)),
  };
};

/** Helmet defaults; HSTS is sent only in production. */
const createSecurityHeaders = ({ isProduction }) =>
  helmet(isProduction ? {} : { strictTransportSecurity: false });

module.exports = {
  JSON_BODY_LIMIT,
  createCorsOptions,
  createSecurityHeaders,
  parseAllowedOrigins,
};
