/*
 * Estimate helpers (pure, no DB). Estimates carry no GST or HSN.
 * The generic sales-document logic lives in ./salesDocuments.js and is
 * re-exported here unchanged so existing callers keep working.
 */
const shared = require("./salesDocuments");

const ESTIMATE_STATUSES = ["active", "cancelled", "converted"];
const NOUN = "an estimate";

/** EST/2026-27/0001 (grows past 4 digits when needed). */
const formatEstimateNumber = (financialYear, sequence) =>
  shared.formatDocumentNumber("EST", financialYear, sequence);

const validateEstimateLines = (lines, { allowReprice = false } = {}) =>
  shared.validateDocumentLines(lines, { allowReprice, noun: NOUN });

const validateCreatePayload = (body, today = shared.getBusinessToday()) => {
  const result = shared.validateCreateDocumentPayload(body, {
    dateField: "estimateDate",
    dateLabel: "Estimate date",
    noun: NOUN,
    kind: "estimate",
    today,
  });
  if (!result.valid) return result;
  const { customer, date, lines, notes } = result.value;
  return { valid: true, value: { customer, estimateDate: date, lines, notes } };
};

const validateEditPayload = (body) =>
  shared.validateEditDocumentPayload(body, {
    dateField: "estimateDate",
    fixedMessage: "Customer and estimate date cannot be changed.",
    noun: NOUN,
    kind: "estimate",
  });

const canEditEstimate = (status) => status === "active";

const canCancelEstimate = (status, validPaymentCount) =>
  status === "active" && validPaymentCount === 0;

module.exports = {
  ESTIMATE_STATUSES,
  MAX_LINES: shared.MAX_LINES,
  MAX_QUANTITY: shared.MAX_QUANTITY,
  buildSummary: shared.buildSummary,
  canCancelEstimate,
  canEditEstimate,
  canRecordPayment: shared.canRecordPayment,
  canVoidPayment: shared.canVoidPayment,
  computeStockDiff: shared.computeStockDiff,
  formatEstimateNumber,
  getBusinessToday: shared.getBusinessToday,
  getFinancialYear: shared.getFinancialYear,
  isValidId: shared.isValidId,
  lineTotal: shared.lineTotal,
  parseBusinessDate: shared.parseBusinessDate,
  sumTotal: shared.sumTotal,
  summarizePayments: shared.summarizePayments,
  toDateKey: shared.toDateKey,
  validateCreatePayload,
  validateEditPayload,
  validateEstimateLines,
  validatePaymentPayload: shared.validatePaymentPayload,
  validateReason: shared.validateReason,
};
