/*
 * Read-only audit log. GET only: there must never be an update or delete
 * route here. Mounted admin-only in index.js.
 */
const express = require("express");
const AuditLog = require("../models/AuditLog");
const { IST_OFFSET_MS } = require("../utils/dashboardResponse");
const { sendServerError } = require("../utils/httpErrors");
const { buildPagedResponse, parseOptionalPagination } = require("../utils/listQuery");
const { parseDateOnly } = require("../utils/supplierAccounting");

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (message) => ({ valid: false, message });

/*
 * Filters: action, recordType, from, to. from and to are Asia/Kolkata calendar
 * days, both included: from IST midnight of `from` up to, not including, IST
 * midnight after `to`.
 */
const parseAuditFilter = (query = {}) => {
  const filter = {};

  for (const field of ["action", "recordType"]) {
    const value = query[field];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 80) return fail(`${field} is invalid.`);
    filter[field] = value;
  }

  const days = {};
  for (const [field, label] of [["from", "From date"], ["to", "To date"]]) {
    const value = query[field];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string") return fail(`${label} is invalid.`);
    const parsed = parseDateOnly(value, label);
    if (!parsed.valid) return parsed;
    days[field] = parsed.value.getTime();
  }

  if (days.from !== undefined && days.to !== undefined && days.from > days.to) {
    return fail("From date cannot be after To date.");
  }

  if (days.from !== undefined || days.to !== undefined) {
    filter.createdAt = {};
    if (days.from !== undefined) filter.createdAt.$gte = new Date(days.from - IST_OFFSET_MS);
    if (days.to !== undefined) {
      filter.createdAt.$lt = new Date(days.to + DAY_MS - IST_OFFSET_MS);
    }
  }

  return { valid: true, value: filter };
};

router.get("/", async (req, res) => {
  try {
    const parsed = parseAuditFilter(req.query);
    if (!parsed.valid) return res.status(400).json({ message: parsed.message });

    // Always paged: page defaults to 1, limit to 20 (maximum 100).
    const paging = parseOptionalPagination(
      { page: req.query.page || 1, limit: req.query.limit },
      { defaultLimit: 20, maxLimit: 100 }
    );

    const [items, total] = await Promise.all([
      AuditLog.find(parsed.value)
        .sort({ createdAt: -1, _id: -1 })
        .skip(paging.skip)
        .limit(paging.limit)
        .lean(),
      AuditLog.countDocuments(parsed.value),
    ]);

    return res.json(buildPagedResponse(items, paging, total));
  } catch (error) {
    return sendServerError(res, "GET /api/audit-log", error);
  }
});

module.exports = router;
module.exports.parseAuditFilter = parseAuditFilter;
