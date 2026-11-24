/*
 * Delivery challan helpers (no DB): numbering, remaining-quantity math, the
 * dispatch cap (single, multiple, cancelled challans freeing quantity),
 * dispatch status, request validation, and the schemas (no GST, GSTIN, price).
 */
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Challan = require("../src/models/Challan");
const ChallanCounter = require("../src/models/ChallanCounter");
const Invoice = require("../src/models/Invoice");
const { getFinancialYear } = require("../src/utils/salesDocuments");
const {
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
} = require("../src/utils/challans");

const oid = () => new mongoose.Types.ObjectId();
const L1 = oid();
const L2 = oid();
const ITEM1 = oid();
const ITEM2 = oid();

const invoiceLines = (overrides = {}) => [
  { _id: L1, item: ITEM1, productName: "Crepe 10cm", unit: "pcs", quantity: 10, dispatchedQuantity: 0, ...overrides.first },
  { _id: L2, item: ITEM2, productName: "Gauze Roll", unit: "dozen", quantity: 4, dispatchedQuantity: 0, ...overrides.second },
];
const request = (...pairs) => pairs.map(([line, quantity]) => ({ invoiceLine: String(line), quantity }));

/* ---------- numbering: own series, April to March ---------- */
assert.equal(formatChallanNumber("2026-27", 1), "CH/2026-27/0001");
assert.equal(formatChallanNumber(getFinancialYear("2027-03-31"), 12), "CH/2026-27/0012");
assert.equal(formatChallanNumber(getFinancialYear("2027-04-01"), 1), "CH/2027-28/0001");
assert.equal(formatChallanNumber("2026-27", 12345), "CH/2026-27/12345");
assert.ok(formatChallanNumber("2026-27", 1).startsWith("CH/"), "never an INV/EST number");

/* ---------- remaining-quantity math ---------- */
assert.equal(remainingQuantity({ quantity: 10, dispatchedQuantity: 0 }), 10);
assert.equal(remainingQuantity({ quantity: 10 }), 10, "an old invoice line without the counter");
assert.equal(remainingQuantity({ quantity: 10, dispatchedQuantity: 7 }), 3);
assert.equal(remainingQuantity({ quantity: 10, dispatchedQuantity: 10 }), 0);
assert.equal(remainingQuantity({ quantity: 10, dispatchedQuantity: 12 }), 0, "never negative");
assert.deepEqual(buildDispatchLines(invoiceLines({ first: { dispatchedQuantity: 6 } })), [
  { invoiceLine: String(L1), item: ITEM1, productName: "Crepe 10cm", unit: "pcs", orderedQuantity: 10, dispatchedQuantity: 6, remainingQuantity: 4 },
  { invoiceLine: String(L2), item: ITEM2, productName: "Gauze Roll", unit: "dozen", orderedQuantity: 4, dispatchedQuantity: 0, remainingQuantity: 4 },
]);
assert.equal(totalQuantity([{ quantity: 7 }, { quantity: 3 }]), 10);

/* ---------- the cap: a single challan ---------- */
let plan = planDispatch(invoiceLines(), request([L1, 10]));
assert.equal(plan.valid, true, "exactly the ordered quantity is allowed");
assert.deepEqual(plan.value.map((line) => [String(line.invoiceLine), line.quantity]), [[String(L1), 10]]);
assert.equal(plan.value[0].productName, "Crepe 10cm");

plan = planDispatch(invoiceLines(), request([L1, 11]));
assert.equal(plan.valid, false, "ordered + 1 is rejected");
assert.equal(plan.statusCode, 409);
assert.equal(plan.message, "Only 10 PCS of Crepe 10cm remain to dispatch.");

plan = planDispatch(invoiceLines(), request([L2, 5]));
assert.equal(plan.message, "Only 4 Dozen of Gauze Roll remain to dispatch.");

/* ---------- the cap: several challans adding up to the cap ---------- */
let lines = invoiceLines();
const challans = [];
const dispatch = (quantities) => {
  const planned = planDispatch(lines, quantities);
  assert.equal(planned.valid, true, planned.message);
  const change = applyDispatchChange(lines, planned.value, 1);
  assert.equal(change.valid, true);
  lines = lines.map((line) => {
    const delta = change.deltas.find((entry) => entry.invoiceLine === String(line._id));
    return delta ? { ...line, dispatchedQuantity: line.dispatchedQuantity + delta.change } : line;
  });
  const challan = { _id: oid(), status: "active", lines: planned.value };
  challans.push(challan);
  return { challan, change };
};

dispatch(request([L1, 4]));
assert.equal(computeDispatchStatus(lines), "partial");
dispatch(request([L1, 3]));
dispatch(request([L1, 3], [L2, 1]));
assert.equal(lines[0].dispatchedQuantity, 10, "three challans add up to exactly the cap");
assert.equal(remainingQuantity(lines[0]), 0);
assert.equal(computeDispatchStatus(lines), "partial", "the second line is not finished");

plan = planDispatch(lines, request([L1, 1]));
assert.equal(plan.valid, false, "the cap plus one is rejected");
assert.equal(plan.message, "Crepe 10cm has no quantity left to dispatch.");

dispatch(request([L2, 3]));
assert.equal(computeDispatchStatus(lines), "full");
assert.equal(planDispatch(lines, request([L2, 1])).valid, false);

/* ---------- counters agree with the challans (audit) ---------- */
const audited = computeDispatchFromChallans(challans);
assert.equal(audited.get(String(L1)), lines[0].dispatchedQuantity);
assert.equal(audited.get(String(L2)), lines[1].dispatchedQuantity);

/* ---------- cancelled challans free their quantity ---------- */
const [firstChallan] = challans;
const cancel = applyDispatchChange(lines, firstChallan.lines, -1);
assert.equal(cancel.valid, true);
assert.deepEqual(cancel.deltas, [{ invoiceLine: String(L1), change: -4 }]);
assert.equal(cancel.dispatchStatus, "partial", "no longer fully dispatched");
lines = lines.map((line) => (String(line._id) === String(L1) ? { ...line, dispatchedQuantity: 6 } : line));
firstChallan.status = "cancelled";
assert.equal(computeDispatchFromChallans(challans).get(String(L1)), 6, "cancelled challans are not counted");
assert.equal(remainingQuantity(lines[0]), 4);
assert.equal(planDispatch(lines, request([L1, 4])).valid, true, "the freed quantity can be dispatched again");
assert.equal(planDispatch(lines, request([L1, 5])).valid, false);

// Cancelling everything returns the invoice to "none".
const none = applyDispatchChange(
  invoiceLines({ first: { dispatchedQuantity: 4 } }),
  [{ invoiceLine: L1, quantity: 4 }],
  -1
);
assert.equal(none.dispatchStatus, "none");

// Counters that would go negative or past the cap are reported, not applied.
assert.equal(applyDispatchChange(invoiceLines(), [{ invoiceLine: L1, quantity: 1 }], -1).valid, false);
assert.equal(applyDispatchChange(invoiceLines(), [{ invoiceLine: L1, quantity: 11 }], 1).valid, false);

/* ---------- other plan errors ---------- */
assert.equal(planDispatch(invoiceLines(), request([oid(), 1])).valid, false, "unknown line");
assert.equal(planDispatch(invoiceLines(), request([L1, 1], [L1, 2])).valid, false, "duplicate line");
[0, -1, 1.5, "3", NaN].forEach((quantity) =>
  assert.equal(planDispatch(invoiceLines(), [{ invoiceLine: String(L1), quantity }]).valid, false, String(quantity))
);

/* ---------- dispatch status ---------- */
assert.equal(computeDispatchStatus(invoiceLines()), "none");
assert.equal(computeDispatchStatus(invoiceLines({ first: { dispatchedQuantity: 1 } })), "partial");
assert.equal(computeDispatchStatus(invoiceLines({ first: { dispatchedQuantity: 10 }, second: { dispatchedQuantity: 4 } })), "full");
assert.equal(computeDispatchStatus([]), "none");

/* ---------- create payload validation ---------- */
const today = "2026-11-24";
const INVOICE_ID = String(oid());
const good = { invoice: INVOICE_ID, challanDate: "2026-11-23", lines: request([L1, 5]) };
let result = validateCreateChallanPayload(good, today);
assert.equal(result.valid, true, result.message);
assert.equal(result.value.challanDate.toISOString(), "2026-11-23T00:00:00.000Z");
assert.deepEqual(result.value.transport, { transporterName: "", vehicleNumber: "", lrNumber: "", lrDate: null });
assert.equal(result.value.notes, "");

assert.equal(
  validateCreateChallanPayload({ ...good, challanDate: undefined }, today).value.challanDate.toISOString(),
  "2026-11-24T00:00:00.000Z",
  "defaults to today (IST)"
);
assert.match(validateCreateChallanPayload({ ...good, challanDate: "2026-11-25" }, today).message, /future/);
assert.equal(validateCreateChallanPayload({ ...good, invoice: "bad" }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, lines: [] }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, lines: undefined }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, lines: [{ invoiceLine: "x", quantity: 1 }] }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, lines: request([L1, 0]) }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, lines: request([L1, 1.5]) }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, lines: request([L1, 100001]) }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, lines: request([L1, 1], [L1, 2]) }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, lines: [{ invoiceLine: String(L1), quantity: "4" }] }, today).value.lines[0].quantity, 4);
assert.equal(validateCreateChallanPayload({ ...good, notes: "x".repeat(501) }, today).valid, false);
assert.equal(validateCreateChallanPayload(null, today).valid, false);

result = validateCreateChallanPayload(
  {
    ...good,
    transport: { transporterName: "  Sharma  Transport ", vehicleNumber: " up32 ab 1234 ", lrNumber: " LR-77 ", lrDate: "2026-11-22" },
    notes: " Fragile ",
  },
  today
);
assert.equal(result.valid, true, result.message);
assert.deepEqual(
  { ...result.value.transport, lrDate: result.value.transport.lrDate.toISOString() },
  { transporterName: "Sharma Transport", vehicleNumber: "UP32 AB 1234", lrNumber: "LR-77", lrDate: "2026-11-22T00:00:00.000Z" }
);
assert.equal(result.value.notes, "Fragile");
assert.equal(validateCreateChallanPayload({ ...good, transport: { vehicleNumber: "x".repeat(21) } }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, transport: { transporterName: "x".repeat(101) } }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, transport: { lrNumber: 5 } }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, transport: { lrDate: "2026-02-30" } }, today).valid, false);
assert.equal(validateCreateChallanPayload({ ...good, transport: "road" }, today).valid, false);

/* ---------- edit is limited to transport and notes ---------- */
result = validateEditChallanPayload({ transport: { transporterName: "VRL", vehicleNumber: "mh12ab1" }, notes: "ok" });
assert.equal(result.valid, true, result.message);
assert.equal(result.value.transport.vehicleNumber, "MH12AB1");
assert.equal(result.value.notes, "ok");
assert.equal(validateEditChallanPayload({ notes: "only notes" }).valid, true);
["lines", "invoice", "customer", "challanDate", "status", "quantity"].forEach((key) =>
  assert.match(
    validateEditChallanPayload({ notes: "x", [key]: 1 }).message,
    /Only the transport details and notes/,
    key
  )
);
assert.equal(validateEditChallanPayload({}).valid, false, "nothing to update");
assert.equal(validateEditChallanPayload({ transport: "x" }).valid, false);
assert.equal(validateEditChallanPayload(null).valid, false);

/* ---------- status rules ---------- */
assert.equal(canEditChallan("active"), true);
assert.equal(canEditChallan("cancelled"), false);
assert.equal(canCancelChallan("active"), true);
assert.equal(canCancelChallan("cancelled"), false, "cannot free a quantity twice");

/* ---------- schemas: no GST, GSTIN, prices or tax anywhere on a challan ---------- */
const forbidden = /gst|price|tax|rate|amount|total(?!Quantity)/i;
const allPaths = (schema, prefix = "") =>
  Object.entries(schema.paths).flatMap(([path, type]) =>
    type.schema ? allPaths(type.schema, `${prefix}${path}.`) : [`${prefix}${path}`]
  );
const challanPaths = allPaths(Challan.schema).filter((path) => !/(^|.)_/.test(path));
assert.ok(challanPaths.length > 30, "walked the whole schema including nested lines");
assert.deepEqual(challanPaths.filter((path) => forbidden.test(path)), [], "no tax or price field on Challan");
assert.equal(challanPaths.some((path) => /gstin|hsn|igst|cgst|sgst|pan|bank/i.test(path)), false);

const challanDoc = new Challan({
  challanNumber: "CH/2026-27/0001",
  financialYear: "2026-27",
  sequence: 1,
  invoice: oid(),
  invoiceNumber: "INV/2026-27/0001",
  invoiceDate: new Date("2026-11-20T00:00:00.000Z"),
  customer: oid(),
  customerSnapshot: { name: "Shree Medicals" },
  challanDate: new Date("2026-11-24T00:00:00.000Z"),
  lines: [{ invoiceLine: L1, item: ITEM1, productName: "Crepe", unit: "pcs", quantity: 5 }],
});
assert.equal(challanDoc.validateSync(), undefined);
assert.equal(challanDoc.status, "active");
assert.equal(challanDoc.transport.lrDate, null);
assert.ok(new Challan({ ...challanDoc.toObject(), lines: [] }).validateSync()?.errors?.lines);
assert.ok(
  new Challan({ ...challanDoc.toObject(), lines: [{ ...challanDoc.lines[0].toObject(), quantity: 0 }] }).validateSync()
);
assert.ok(new Challan({ ...challanDoc.toObject(), status: "draft" }).validateSync()?.errors?.status);

const indexes = Challan.schema.indexes();
assert.ok(indexes.find(([fields, options]) => fields.challanNumber === 1 && options.unique), "unique number");
["invoice", "customer", "status"].forEach((key) =>
  assert.ok(indexes.find(([fields]) => fields[key] === 1 && fields.challanDate === -1), `${key}+date index`)
);
assert.equal(ChallanCounter.schema.path("financialYear").options.unique, true);

// Invoice dispatch counters default to "nothing dispatched" (old invoices stay valid).
const invoiceDefaults = new Invoice({});
assert.equal(invoiceDefaults.activeChallanCount, 0);
assert.equal(invoiceDefaults.dispatchStatus, "none");
assert.equal(Invoice.schema.path("lines").schema.path("dispatchedQuantity").options.default, 0);
assert.ok(new Invoice({ dispatchStatus: "shipped" }).validateSync()?.errors?.dispatchStatus);

console.log("Challan helpers: all assertions passed.");
