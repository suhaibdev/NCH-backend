/*
 * Public enquiry endpoint: placeholder only. The enquiry form, its storage,
 * honeypot and Cloudflare Turnstile come in step 14. The rate limit already
 * applies here.
 */
const express = require("express");
const { enquiryLimiter } = require("../middleware/rateLimits");

const router = express.Router();

router.post("/", enquiryLimiter, (req, res) =>
  res.status(501).json({ message: "Not available yet." })
);

module.exports = router;
