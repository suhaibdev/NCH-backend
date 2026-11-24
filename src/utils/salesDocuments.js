/*
 * Shared helpers for sales documents (Estimates, Invoices). Pure, no DB.
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
const MAX_BATCH_REFERENCE = 100;

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

/** PREFIX/2026-27/0001 (grows past 4 digits when needed). */
const formatDocumentNumber = (prefix, financialYear, sequence) =>
  `${prefix}/${financialYear}/${String(sequence).padStart(4, "0")}`;

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

const cleanBatchReference = (value, label) => {
  if (value === undefined || value === null) return { valid: true, value: "" };
  if (typeof value !== "string") return fail(`${label} batch reference must be text.`);
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length > MAX_BATCH_REFERENCE) {
    return fail(`${label} batch reference must be ${MAX_BATCH_REFERENCE} characters or fewer.`);
  }
  return { valid: true, value: cleaned };
};

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Validates document lines: 1..100 lines, valid ids, each product once,
 * quantity 1..100000. `reprice` only when allowed (edits). `batchReference`
 * is accepted only when allowed (invoices) and otherwise ignored.
 * `noun` is the document with its article, e.g. "an estimate", "an invoice".
 */
const validateDocumentLines = (
  lines,
  { allowReprice = false, allowBatchReference = false, noun = "a document" } = {}
) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    return fail("Add at least one product line.");
  }
  if (lines.length > MAX_LINES) {
    return fail(`${capitalize(noun)} can have at most ${MAX_LINES} lines.`);
  }

  const seen = new Set();
  const value = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const label = `Line ${index + 1}`;
    if (!line || typeof line !== "object") return fail(`${label} is invalid.`);

    const item = typeof line.item === "string" ? line.item.trim() : "";
    if (!isValidId(item)) return fail(`${label} product is invalid.`);
    if (seen.has(item)) return fail(`Each product can appear only once in ${noun}.`);
    seen.add(item);

    const quantity =
      typeof line.quantity === "string" && /^\d+$/.test(line.quantity.trim())
        ? Number(line.quantity.trim())
        : line.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return fail(`${label} quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    }

    if (line.reprice !== undefined && typeof line.reprice !== "boolean") {
      return fail(`${label} re-price flag must be true or false.`);
    }
    if (line.reprice && !allowReprice) {
      return fail(`${label} cannot be re-priced when creating ${noun}.`);
    }

    const entry = { item, quantity, reprice: Boolean(line.reprice) };

    if (allowBatchReference) {
      const batch = cleanBatchReference(line.batchReference, label);
      if (!batch.valid) return batch;
      entry.batchReference = batch.value;
    }

    value.push(entry);
  }

  return { valid: true, value };
};

const cleanNotes = (value) => cleanOptionalText(value, "Notes", 500);

/** Create payload: customer, date (default today, not future), lines, notes. */
const validateCreateDocumentPayload = (
  body,
  { dateField, dateLabel, noun, kind, today = getBusinessToday(), allowBatchReference = false }
) => {
  if (!body || typeof body !== "object") return fail(`Invalid ${kind} data.`);

  const customer = typeof body.customer === "string" ? body.customer.trim() : "";
  if (!isValidId(customer)) return fail("Select a valid customer.");

  const rawDate = body[dateField];
  const date = parseBusinessDate(rawDate === undefined || rawDate === "" ? today : rawDate, dateLabel, today);
  if (!date.valid) return date;

  const lines = validateDocumentLines(body.lines, { allowBatchReference, noun });
  if (!lines.valid) return lines;

  const notes = cleanNotes(body.notes);
  if (!notes.valid) return notes;

  return {
    valid: true,
    value: { customer, date: date.value, lines: lines.value, notes: notes.value },
  };
};

/** Edit payload: lines and notes only; customer and date are fixed. */
const validateEditDocumentPayload = (
  body,
  { dateField, fixedMessage, noun, kind, allowBatchReference = false }
) => {
  if (!body || typeof body !== "object") return fail(`Invalid ${kind} data.`);
  if (body.customer !== undefined || body[dateField] !== undefined) {
    return fail(fixedMessage);
  }
  const lines = validateDocumentLines(body.lines, {
    allowReprice: true,
    allowBatchReference,
    noun,
  });
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

const sumTotal = (lines, field = "lineTotalPaise") =>
  lines.reduce((sum, line) => {
    const next = sum + line[field];
    if (!Number.isSafeInteger(next)) throw new Error("Document total is out of range.");
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

const canRecordPayment = (outstandingPaise, amountPaise) =>
  Number.isSafeInteger(amountPaise) &&
  amountPaise > 0 &&
  Number.isSafeInteger(outstandingPaise) &&
  outstandingPaise > 0 &&
  amountPaise <= outstandingPaise;

const canVoidPayment = (payment, documentStatus) =>
  Boolean(payment) && payment.voided !== true && documentStatus === "active";

module.exports = {
  MAX_BATCH_REFERENCE,
  MAX_LINES,
  MAX_QUANTITY,
  buildSummary,
  canRecordPayment,
  canVoidPayment,
  cleanNotes,
  computeStockDiff,
  formatDocumentNumber,
  getBusinessToday,
  getFinancialYear,
  isValidId,
  lineTotal,
  parseBusinessDate,
  sumTotal,
  summarizePayments,
  toDateKey,
  validateCreateDocumentPayload,
  validateDocumentLines,
  validateEditDocumentPayload,
  validatePaymentPayload,
  validateReason,
};
