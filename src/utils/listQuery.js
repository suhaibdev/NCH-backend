/*
 * Shared helpers for list endpoints that must stay backward compatible.
 *
 * Legacy mode (no ?page and no ?limit): the endpoint returns the same array it
 * always did, but never more than `cap` rows. Paged mode (?page or ?limit sent):
 * the endpoint returns { items, page, limit, total, totalPages }.
 */

const CAPPED_HEADER = "X-Result-Capped";

const toPositiveInt = (value) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const parseOptionalPagination = (query = {}, { cap, maxLimit = 100, defaultLimit = 20 } = {}) => {
  const hasPaging = query.page !== undefined || query.limit !== undefined;

  if (!hasPaging) {
    // Fetch one extra row so truncation can be detected without a count query.
    return { paged: false, skip: 0, limit: cap + 1, cap };
  }

  const page = toPositiveInt(query.page) || 1;
  const limit = Math.min(maxLimit, toPositiveInt(query.limit) || defaultLimit);
  return { paged: true, page, limit, skip: (page - 1) * limit, cap };
};

/** Legacy mode: trims the extra probe row and reports whether the cap was hit. */
const applyLegacyCap = (rows, cap) => {
  const capped = rows.length > cap;
  return { rows: capped ? rows.slice(0, cap) : rows, capped };
};

const buildPagedResponse = (items, { page, limit }, total) => ({
  items,
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

/**
 * Runs a list query in either mode and sends the response.
 * `buildQuery()` must return a fresh, un-executed Mongoose query that already has
 * its filter, sort and populate; `countQuery()` returns the total for paged mode.
 */
const sendListResponse = async (res, query, options, buildQuery, countQuery, transform) => {
  const paging = parseOptionalPagination(query, options);
  const map = transform || ((rows) => rows);

  if (paging.paged) {
    const [rows, total] = await Promise.all([
      buildQuery().skip(paging.skip).limit(paging.limit),
      countQuery(),
    ]);
    return res.json(buildPagedResponse(map(rows), paging, total));
  }

  const { rows, capped } = applyLegacyCap(await buildQuery().limit(paging.limit), paging.cap);
  if (capped) res.set(CAPPED_HEADER, "true");
  return res.json(map(rows));
};

/** Re-adds the StockItem schema virtuals that plain lean() documents lack. */
const withStockVirtuals = (item) => {
  if (!item) return item;
  return {
    ...item,
    quantityInPieces: item.unit === "dozen" ? item.currentStock * 12 : item.currentStock,
    isLowStock: item.currentStock <= item.minimumStock,
    id: String(item._id),
  };
};

module.exports = {
  CAPPED_HEADER,
  applyLegacyCap,
  buildPagedResponse,
  parseOptionalPagination,
  sendListResponse,
  withStockVirtuals,
};
