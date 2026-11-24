/*
 * Estimate to Invoice conversion helpers (pure, no DB). Step 11D.
 *
 * Conversion never touches stock: the estimate already deducted it, and the
 * invoice takes over those units. Estimate prices are GST-exclusive taxable
 * prices; GST is added on top by the invoice tax rules in gstInvoice.js.
 */
const {
  buildSummary,
  cleanBatchReference,
  cleanNotes,
  getBusinessToday,
  isValidId,
  lineTotal,
  parseBusinessDate,
} = require("./salesDocuments");
const { computeInvoiceTax, missingTaxMetadataMessage } = require("./gstInvoice");

const fail = (message) => ({ valid: false, message });

/** Only an active estimate can be converted (converted, cancelled: never). */
const isConvertible = (status) => status === "active";

/** Message when an estimate cannot be converted because of its status, or "". */
const notConvertibleMessage = (estimate) => {
  if (estimate.status === "converted") {
    return estimate.convertedInvoiceNumber
      ? `This estimate has already been converted to ${estimate.convertedInvoiceNumber}.`
      : "This estimate has already been converted to an invoice.";
  }
  if (!isConvertible(estimate.status)) return "Only active estimates can be converted.";
  return "";
};

/**
 * Body of POST /:id/convert. Only the invoice date, notes and per-line batch
 * references can be sent; quantities and prices are never accepted.
 * `invoiceDate` defaults to today (IST), may not be in the future. The check
 * "not before the estimate date" needs the estimate and runs in the route.
 */
const validateConvertPayload = (body, today = getBusinessToday()) => {
  const source = body === undefined || body === null ? {} : body;
  if (typeof source !== "object" || Array.isArray(source)) return fail("Invalid conversion data.");

  const date = parseBusinessDate(
    source.invoiceDate === undefined || source.invoiceDate === "" ? today : source.invoiceDate,
    "Invoice date",
    today
  );
  if (!date.valid) return date;

  const notes = cleanNotes(source.notes);
  if (!notes.valid) return notes;

  const batchByItem = new Map();
  if (source.lines !== undefined) {
    if (!Array.isArray(source.lines) || source.lines.length > 100) {
      return fail("Batch references must be a list of up to 100 lines.");
    }
    for (let index = 0; index < source.lines.length; index += 1) {
      const entry = source.lines[index];
      const label = `Line ${index + 1}`;
      if (!entry || typeof entry !== "object") return fail(`${label} is invalid.`);
      const item = typeof entry.item === "string" ? entry.item.trim() : "";
      if (!isValidId(item)) return fail(`${label} product is invalid.`);
      if (batchByItem.has(item)) return fail("Each product can appear only once.");
      const batch = cleanBatchReference(entry.batchReference, label);
      if (!batch.valid) return batch;
      batchByItem.set(item, batch.value);
    }
  }

  return { valid: true, value: { invoiceDate: date.value, notes: notes.value, batchByItem } };
};

/**
 * Invoice lines from the estimate's saved snapshots (price, quantity, name,
 * unit) plus the item's CURRENT HSN code and GST rate. Items that are missing
 * or lack tax metadata are reported by name. `itemsById` maps item id to the
 * StockItem fields { productName, category, hsnCode, gstRatePercent }.
 */
const buildConversionLines = (estimateLines, itemsById, batchByItem = new Map()) => {
  const problems = [];
  const lines = [];

  for (const line of estimateLines) {
    const key = String(line.item);
    const item = itemsById.get(key);
    if (!item) {
      problems.push(`${line.productName} was not found.`);
      continue;
    }
    if (item.category !== "finished_goods") {
      problems.push(`${line.productName} is not a Finished Goods product.`);
      continue;
    }
    const missing = missingTaxMetadataMessage({ ...item, productName: line.productName });
    if (missing) {
      problems.push(missing);
      continue;
    }
    lines.push({
      item: line.item,
      productName: line.productName,
      unit: line.unit,
      hsnCode: item.hsnCode,
      gstRatePercent: item.gstRatePercent,
      quantity: line.quantity,
      pricePaise: line.pricePaise,
      taxablePaise: lineTotal(line.quantity, line.pricePaise),
      batchReference: batchByItem.get(key) || "",
    });
  }

  return { lines, problems };
};

/** computeInvoiceTax that reports an out-of-range amount as a problem, not a throw. */
const planConversionTax = (lines, taxType) => {
  try {
    return { tax: computeInvoiceTax(lines, taxType), problem: "" };
  } catch (err) {
    if (err?.statusCode === 400) return { tax: null, problem: err.message };
    throw err;
  }
};

/**
 * Payments carried over to the invoice: the estimate's valid (not voided, not
 * already transferred) payments. They may not exceed the invoice total.
 */
const planCarryOver = (payments, invoiceTotalPaise) => {
  const carried = payments.filter((payment) => !payment.voided && !payment.transferred);
  const paidPaise = carried.reduce((sum, payment) => sum + (Number(payment.amountPaise) || 0), 0);
  return {
    payments: carried,
    paidPaise,
    count: carried.length,
    exceedsTotal: Number.isSafeInteger(invoiceTotalPaise) && paidPaise > invoiceTotalPaise,
  };
};

/**
 * Summary shown on estimate detail. A converted estimate has left the
 * estimate ledger: nothing paid, nothing outstanding; the carried amount is
 * reported as transferredPaise. Other statuses keep the 11B summary.
 */
const buildEstimateSummary = (estimate, payments = []) => {
  const transferred = payments.filter((payment) => payment.transferred && !payment.voided);
  const transferredPaise = transferred.reduce(
    (sum, payment) => sum + (Number(payment.amountPaise) || 0),
    0
  );

  if (estimate.status === "converted") {
    return {
      totalPaise: estimate.totalPaise,
      paidPaise: 0,
      outstandingPaise: 0,
      paymentCount: 0,
      voidedCount: payments.filter((payment) => payment.voided).length,
      transferredPaise,
      transferredCount: transferred.length,
    };
  }

  const own = payments.filter((payment) => !payment.transferred);
  return {
    ...buildSummary(estimate.totalPaise, own),
    transferredPaise,
    transferredCount: transferred.length,
  };
};

/**
 * Customer estimate account from the two aggregations. Only ACTIVE estimates
 * count toward the total; converted estimates have moved to the invoice
 * ledger (their payments are transferred and excluded by the query).
 */
const buildEstimateAccount = (estimateRows, paymentRows) => {
  const byStatus = new Map(estimateRows.map((row) => [row._id, row]));
  const totalEstimatedPaise = Number(byStatus.get("active")?.totalPaise || 0);
  const totalPaidPaise = Number(paymentRows[0]?.paidPaise || 0);
  return {
    activeCount: Number(byStatus.get("active")?.count || 0),
    cancelledCount: Number(byStatus.get("cancelled")?.count || 0),
    convertedCount: Number(byStatus.get("converted")?.count || 0),
    totalEstimatedPaise,
    totalPaidPaise,
    outstandingPaise: totalEstimatedPaise - totalPaidPaise,
    paymentCount: Number(paymentRows[0]?.count || 0),
  };
};

module.exports = {
  buildConversionLines,
  buildEstimateAccount,
  buildEstimateSummary,
  isConvertible,
  notConvertibleMessage,
  planCarryOver,
  planConversionTax,
  validateConvertPayload,
};
