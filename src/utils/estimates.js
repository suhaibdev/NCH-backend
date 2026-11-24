/*
 * Estimate helpers (pure, no DB). Estimates carry no GST or HSN.
 * Money is integer paise; quantities are whole numbers in the item's unit.
 */
const mongoose = require("mongoose");
const {
  PAYMENT_METHODS,
  cleanOptionalText,
  parseDateOnly,
  parseRupeesToPaise,
} = require("./supplierAccounting");

const MAX_LINES = 100;
const MAX_QUANTITY = 100000;
const ESTIMATE_STATUSES = ["active", "cancelled", "converted"];

const isValidId = (value) =>
  typeof value === "string" &&
  mongoose.Types.ObjectId.isValid(value) &&
  String(new mongoose.Types.ObjectId(value)) === value;

/** Today's business date (Asia/Kolkata) as YYYY-MM-DD. */
const getBusinessToday = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

const toDateKey = (value) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || "").slice(0, 10);
};

/**
 * Financial year (April to March) of a date-only value.
 * "2027-03-31" -> "2026-27", "2027-04-01" -> "2027-28".
 */
const getFinancialYear = (value) => {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(toDateKey(value));
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
};

/** EST/2026-27/0001 (grows past 4 digits when needed). */
const formatEstimateNumber = (financialYear, sequence) =>
  `EST/${financialYear}/${String(sequence).padStart(4, "0")}`;

/** Date-only value that may not be after today's business date. */
const parseBusinessDate = (value, field, today = getBusinessToday()) => {
  const result = parseDateOnly(value, field);
  if (!result.valid) return result;
  if (toDateKey(result.value) > today) {
    return { valid: false, message: `${field} cannot be in the future.` };
  }
  return result;
};

const fail = (message) => ({ valid: false, message });

const validateEstimateLines = (lines, { allowReprice = false } = {}) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    return fail("Add at least one product line.");
  }
  if (lines.length > MAX_LINES) {
    return fail(`An estimate can have at most ${MAX_LINES} lines.`);
  }

  const seen = new Set();
  const value = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const label = `Line ${index + 1}`;
    if (!line || typeof line !== "object") return fail(`${label} is invalid.`);

    const item = typeof line.item === "string" ? line.item.trim() : "";
    if (!isValidId(item)) return fail(`${label} product is invalid.`);
    if (seen.has(item)) return fail("Each product can appear only once in an estimate.");
    seen.add(item);

    const quantity = typeof line.quantity === "string" && /^\d+$/.test(line.quantity.trim())
      ? Number(line.quantity.trim())
      : line.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return fail(`${label} quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    }

    if (line.reprice !== undefined && typeof line.reprice !== "boolean") {
      return fail(`${label} re-price flag must be true or false.`);
    }
    if (line.reprice && !allowReprice) {
      return fail(`${label} cannot be re-priced when creating an estimate.`);
    }

    value.push({ item, quantity, reprice: Boolean(line.reprice) });
  }

  return { valid: true, value };
};

const cleanNotes = (value) => cleanOptionalText(value, "Notes", 500);

const validateCreatePayload = (body, today = getBusinessToday()) => {
  if (!body || typeof body !== "object") return fail("Invalid estimate data.");

  const customer = typeof body.customer === "string" ? body.customer.trim() : "";
  if (!isValidId(customer)) return fail("Select a valid customer.");

  const date = parseBusinessDate(
    body.estimateDate === undefined || body.estimateDate === "" ? today : body.estimateDate,
    "Estimate date",
    today
  );
  if (!date.valid) return date;

  const lines = validateEstimateLines(body.lines);
  if (!lines.valid) return lines;

  const notes = cleanNotes(body.notes);
  if (!notes.valid) return notes;

  return {
    valid: true,
    value: { customer, estimateDate: date.value, lines: lines.value, notes: notes.value },
  };
};

const validateEditPayload = (body) => {
  if (!body || typeof body !== "object") return fail("Invalid estimate data.");
  if (body.customer !== undefined || body.estimateDate !== undefined) {
    return fail("Customer and estimate date cannot be changed.");
  }
  const lines = validateEstimateLines(body.lines, { allowReprice: true });
  if (!lines.valid) return lines;
  const notes = cleanNotes(body.notes);
  if (!notes.valid) return notes;
  return { valid: true, value: { lines: lines.value, notes: notes.value } };
};

const validateReason = (value, label = "Reason") => {
  if (typeof value !== "string" || !value.trim()) return fail(`${label} is required.`);
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length > 250) return fail(`${label} must be 250 characters or fewer.`);
  return { valid: true, value: cleaned };
};

const validatePaymentPayload = (body, today = getBusinessToday()) => {
  if (!body || typeof body !== "object") return fail("Invalid payment data.");

  const amount = parseRupeesToPaise(body.amount, "Payment amount");
  if (!amount.valid) return amount;

  const date = parseBusinessDate(body.paymentDate, "Payment date", today);
  if (!date.valid) return date;

  const method = typeof body.method === "string" ? body.method.trim() : "";
  if (!PAYMENT_METHODS.includes(method)) return fail("Payment method is invalid.");

  const reference = cleanOptionalText(body.reference, "Reference", 150);
  if (!reference.valid) return reference;
  const notes = cleanNotes(body.notes);
  if (!notes.valid) return notes;

  return {
    valid: true,
    value: {
      amountPaise: amount.value,
      paymentDate: date.value,
      method,
      reference: reference.value,
      notes: notes.value,
    },
  };
};

/* ---------- money ---------- */

const lineTotal = (quantity, pricePaise) => {
  const total = quantity * pricePaise;
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(pricePaise) || !Number.isSafeInteger(total)) {
    throw new Error("Line total is out of range.");
  }
  return total;
};

const sumTotal = (lines) =>
  lines.reduce((sum, line) => {
    const next = sum + line.lineTotalPaise;
    if (!Number.isSafeInteger(next)) throw new Error("Estimate total is out of range.");
    return next;
  }, 0);

const summarizePayments = (payments = []) =>
  payments.reduce(
    (summary, payment) => {
      if (payment.voided) {
        summary.voidedCount += 1;
      } else {
        summary.paidPaise += Number(payment.amountPaise) || 0;
        summary.paymentCount += 1;
      }
      return summary;
    },
    { paidPaise: 0, paymentCount: 0, voidedCount: 0 }
  );

const buildSummary = (totalPaise, payments) => {
  const { paidPaise, paymentCount, voidedCount } = summarizePayments(payments);
  return {
    totalPaise,
    paidPaise,
    outstandingPaise: totalPaise - paidPaise,
    paymentCount,
    voidedCount,
  };
};

/* ---------- stock difference on edit ---------- */

/**
 * Per-product stock change between the saved lines and the edited lines.
 * delta > 0: deduct more stock; delta < 0: return stock. Zero deltas dropped,
 * sorted by item id so every transaction touches items in the same order.
 */
const computeStockDiff = (oldLines = [], newLines = []) => {
  const quantities = new Map();
  oldLines.forEach((line) => {
    const key = String(line.item);
    quantities.set(key, (quantities.get(key) || 0) - line.quantity);
  });
  newLines.forEach((line) => {
    const key = String(line.item);
    quantities.set(key, (quantities.get(key) || 0) + line.quantity);
  });
  return [...quantities.entries()]
    .filter(([, delta]) => delta !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([item, delta]) => ({ item, delta }));
};

/* ---------- status rules ---------- */

const canEditEstimate = (status) => status === "active";

const canCancelEstimate = (status, validPaymentCount) =>
  status === "active" && validPaymentCount === 0;

const canRecordPayment = (outstandingPaise, amountPaise) =>
  Number.isSafeInteger(amountPaise) &&
  amountPaise > 0 &&
  Number.isSafeInteger(outstandingPaise) &&
  outstandingPaise > 0 &&
  amountPaise <= outstandingPaise;

const canVoidPayment = (payment, estimateStatus) =>
  Boolean(payment) && payment.voided !== true && estimateStatus === "active";

module.exports = {
  ESTIMATE_STATUSES,
  MAX_LINES,
  MAX_QUANTITY,
  buildSummary,
  canCancelEstimate,
  canEditEstimate,
  canRecordPayment,
  canVoidPayment,
  computeStockDiff,
  formatEstimateNumber,
  getBusinessToday,
  getFinancialYear,
  isValidId,
  lineTotal,
  parseBusinessDate,
  sumTotal,
  summarizePayments,
  toDateKey,
  validateCreatePayload,
  validateEditPayload,
  validateEstimateLines,
  validatePaymentPayload,
  validateReason,
};
