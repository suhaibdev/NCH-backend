const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

/**
 * Sends a safe 500. The real error is logged on the server only (never the
 * request body); the client sees a generic or route-specific friendly message.
 */
const sendServerError = (res, route, err, message = GENERIC_ERROR_MESSAGE) => {
  console.error(`${route} ERROR:`, err);
  return res.status(500).json({ message });
};

module.exports = { GENERIC_ERROR_MESSAGE, sendServerError };
