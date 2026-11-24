/*
 * Delivery Challan helpers (pure, no DB). Step 11E.
 *
 * A challan is a manual dispatch record against one invoice: no GST, no
 * prices, no stock effect, no ledger effect. The one hard rule is the cap:
 * dispatched quantity per invoice line, across all ACTIVE challans, never
 * exceeds the invoice line quantity.
 */
const {
  cleanNotes,
  formatDocumentNumber,
  getBusinessToday,
  isValidId,
  parseBusinessDate,
} = require("./salesDocuments");
const { cleanOptionalText } = require("./supplierAccounting");

const CHALLAN_STATUSES = ["active", "cancelled"];
const DISPATCH_STATUSES = ["none", "partial", "full"];
const MAX_LINES = 100;

const UNIT_LABELS = { pcs: "PCS", dozen: "Dozen" };
const unitText = (unit) => UNIT_LABELS[unit] || unit || "";

const fail = (message, statusCode = 400) => ({ valid: false, message, statusCode });

/** CH/2026-27/0001 (own series; grows past 4 digits when needed). */
const formatChallanNumber = (financialYear, sequence) =>
  formatDocumentNumber("CH", financialYear, sequence);

const dispatched = (line) => Number(line.dispatchedQuantity) || 0;

/** Quantity still available to dispatch on an invoice line. */
const remainingQuantity = (line) => Math.max(0, Number(line.quantity) - dispatched(line));

/** none: nothing dispatched; full: every line fully dispatched; otherwise partial. */
const computeDispatchStatus = (invoiceLines) => {
  if (!Array.isArray(invoiceLines) || invoiceLines.length === 0) return "none";
  if (invoiceLines.every((line) => dispatched(line) === 0)) return "none";
  if (invoiceLines.every((line) => dispatched(line) >= Number(line.quantity))) return "full";
  return "partial";
};

/** Per-line ordered / dispatched / remaining for the invoice screens. */
const buildDispatchLines = (invoiceLines) =>
  invoiceLines.map((line) => ({
    invoiceLine: String(line._id),
    item: line.item,
    productName: line.productName,
    unit: line.unit,
    orderedQuantity: line.quantity,
    dispatchedQuantity: dispatched(line),
    remainingQuantity: remainingQuantity(line),
  }));

const totalQuantity = (lines) => lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);

/**
 * Checks a requested dispatch against the invoice: every line must exist on
 * the invoice, each at most once, and quantity <= ordered - dispatched.
 * Returns { valid, value: [{invoiceLine, item, productName, unit, quantity}] }
 * or { valid: false, message, statusCode } (400 bad line, 409 over the cap).
 */
const planDispatch = (invoiceLines, requested) => {
  const byId = new Map(invoiceLines.map((line) => [String(line._id), line]));
  const seen = new Set();
  const value = [];

  for (const request of requested) {
    const id = String(request.invoiceLine);
    const line = byId.get(id);
    if (!line) return fail("A dispatch line does not belong to this invoice.");
    if (seen.has(id)) return fail("Each invoice line can appear only once on a challan.");
    seen.add(id);

    if (!Number.isSafeInteger(request.quantity) || request.quantity < 1) {
      return fail(`${line.productName}: quantity must be a whole number greater than 0.`);
    }

    const remaining = remainingQuantity(line);
    if (request.quantity > remaining) {
      return fail(
        remaining === 0
          ? `${line.productName} has no quantity left to dispatch.`
          : `Only ${remaining} ${unitText(line.unit)} of ${line.productName} remain to dispatch.`,
        409
      );
    }

    value.push({
      invoiceLine: line._id,
      item: line.item,
      productName: line.productName,
      unit: line.unit,
      quantity: request.quantity,
    });
  }

  return { valid: true, value };
};

/**
 * New dispatch counters after creating (direction +1) or cancelling (-1) a
 * challan with `changes` ([{invoiceLine, quantity}]). Returns the per-line
 * deltas to $inc and the resulting dispatchStatus. A cancel that would push
 * a line below zero means the counters are inconsistent: reported, not applied.
 */
const applyDispatchChange = (invoiceLines, changes, direction) => {
  const delta = new Map(
    changes.map((change) => [String(change.invoiceLine), direction * change.quantity])
  );

  const next = invoiceLines.map((line) => {
    const change = delta.get(String(line._id)) || 0;
    return { ...line, dispatchedQuantity: dispatched(line) + change };
  });

  if (next.some((line) => line.dispatchedQuantity < 0 || line.dispatchedQuantity > line.quantity)) {
    return { valid: false, message: "Dispatch quantities are out of step. Please retry.", statusCode: 409 };
  }

  return {
    valid: true,
    deltas: [...delta.entries()].map(([invoiceLine, change]) => ({ invoiceLine, change })),
    dispatchStatus: computeDispatchStatus(next),
  };
};

/** Dispatched quantity per invoice line recomputed from the challans (audit check). */
const computeDispatchFromChallans = (challans) => {
  const totals = new Map();
  challans
    .filter((challan) => challan.status === "active")
    .forEach((challan) =>
      challan.lines.forEach((line) => {
        const key = String(line.invoiceLine);
        totals.set(key, (totals.get(key) || 0) + line.quantity);
      })
    );
  return totals;
};

/* ---------- request validation ---------- */

const cleanTransport = (value, { requireObject = false } = {}) => {
  if (value === undefined || value === null) {
    return requireObject
      ? fail("Transport details must be an object.")
      : { valid: true, value: { transporterName: "", vehicleNumber: "", lrNumber: "", lrDate: null } };
  }
  if (typeof value !== "object" || Array.isArray(value)) return fail("Transport details are invalid.");

  const transporter = cleanOptionalText(value.transporterName, "Transporter name", 100);
  if (!transporter.valid) return transporter;
  const lr = cleanOptionalText(value.lrNumber, "LR number", 50);
  if (!lr.valid) return lr;

  const vehicle = cleanOptionalText(value.vehicleNumber, "Vehicle number", 20);
  if (!vehicle.valid) return vehicle;

  let lrDate = null;
  if (value.lrDate !== undefined && value.lrDate !== null && value.lrDate !== "") {
    const parsed = parseBusinessDate(value.lrDate, "LR date");
    if (!parsed.valid) return parsed;
    lrDate = parsed.value;
  }

  return {
    valid: true,
    value: {
      transporterName: transporter.value.replace(/\s+/g, " "),
      vehicleNumber: vehicle.value.replace(/\s+/g, " ").toUpperCase(),
      lrNumber: lr.value,
      lrDate,
    },
  };
};

const validateCreateChallanPayload = (body, today = getBusinessToday()) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid challan data.");

  const invoice = typeof body.invoice === "string" ? body.invoice.trim() : "";
  if (!isValidId(invoice)) return fail("Select a valid invoice.");

  const date = parseBusinessDate(
    body.challanDate === undefined || body.challanDate === "" ? today : body.challanDate,
    "Challan date",
    today
  );
  if (!date.valid) return date;

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return fail("Add at least one line to dispatch.");
  }
  if (body.lines.length > MAX_LINES) return fail(`A challan can have at most ${MAX_LINES} lines.`);

  const seen = new Set();
  const lines = [];
  for (let index = 0; index < body.lines.length; index += 1) {
    const entry = body.lines[index];
    const label = `Line ${index + 1}`;
    if (!entry || typeof entry !== "object") return fail(`${label} is invalid.`);

    const invoiceLine = typeof entry.invoiceLine === "string" ? entry.invoiceLine.trim() : "";
    if (!isValidId(invoiceLine)) return fail(`${label} is not a valid invoice line.`);
    if (seen.has(invoiceLine)) return fail("Each invoice line can appear only once on a challan.");
    seen.add(invoiceLine);

    const quantity =
      typeof entry.quantity === "string" && /^\d+$/.test(entry.quantity.trim())
        ? Number(entry.quantity.trim())
        : entry.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) {
      return fail(`${label} quantity must be a whole number from 1 to 100000.`);
    }
    lines.push({ invoiceLine, quantity });
  }

  const transport = cleanTransport(body.transport);
  if (!transport.valid) return transport;

  const notes = cleanNotes(body.notes);
  if (!notes.valid) return notes;

  return {
    valid: true,
    value: { invoice, challanDate: date.value, lines, transport: transport.value, notes: notes.value },
  };
};

/** Edit is limited to the transport block and notes; nothing else may be sent. */
const validateEditChallanPayload = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid challan data.");

  const allowed = new Set(["transport", "notes"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return fail("Only the transport details and notes of a challan can be edited. Cancel it to change quantities.");
  }
  if (body.transport === undefined && body.notes === undefined) {
    return fail("Nothing to update.");
  }

  const value = {};
  if (body.transport !== undefined) {
    const transport = cleanTransport(body.transport, { requireObject: true });
    if (!transport.valid) return transport;
    value.transport = transport.value;
  }
  if (body.notes !== undefined) {
    const notes = cleanNotes(body.notes);
    if (!notes.valid) return notes;
    value.notes = notes.value;
  }
  return { valid: true, value };
};

const canEditChallan = (status) => status === "active";
const canCancelChallan = (status) => status === "active";

module.exports = {
  CHALLAN_STATUSES,
  DISPATCH_STATUSES,
  MAX_LINES,
  applyDispatchChange,
  buildDispatchLines,
  canCancelChallan,
  canEditChallan,
  computeDispatchFromChallans,
  computeDispatchStatus,
  formatChallanNumber,
  planDispatch,
  remainingQuantity,
  totalQuantity,
  validateCreateChallanPayload,
  validateEditChallanPayload,
};
