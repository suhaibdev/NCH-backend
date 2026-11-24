/*
 * Estimate to Invoice conversion helpers (no DB): eligibility, conversion
 * math, payment carry-over rules, converted-estimate summary, request
 * validation, and the models' conversion fields.
 */
const assert = require("node:assert/strict");
const Estimate = require("../src/models/Estimate");
const EstimatePayment = require("../src/models/EstimatePayment");
const InvoicePayment = require("../src/models/InvoicePayment");
const Invoice = require("../src/models/Invoice");
const { computeInvoiceTax } = require("../src/utils/gstInvoice");
const {
  buildConversionLines,
  buildEstimateAccount,
  buildEstimateSummary,
  isConvertible,
  notConvertibleMessage,
  planCarryOver,
  planConversionTax,
  validateConvertPayload,
} = require("../src/utils/estimateConversion");

const ID = (n) => `64d0000000000000000000${String(n).padStart(2, "0")}`;
const A = ID(1);
const B = ID(2);

const estimateLines = [
  { item: A, productName: "Crepe 10cm", unit: "pcs", quantity: 7, pricePaise: 3333, lineTotalPaise: 23331 },
  { item: B, productName: "Gauze Roll", unit: "dozen", quantity: 3, pricePaise: 9999, lineTotalPaise: 29997 },
];
const items = (overrides = {}) =>
  new Map([
    [A, { productName: "Crepe 10cm", category: "finished_goods", hsnCode: "3005", gstRatePercent: 5 }],
    [B, { productName: "Gauze Roll", category: "finished_goods", hsnCode: "30059040", gstRatePercent: 18 }],
  ]).set(overrides.id || "x", overrides.item || {});

/* ---------- eligibility ---------- */
assert.equal(isConvertible("active"), true);
assert.equal(isConvertible("converted"), false, "double conversion");
assert.equal(isConvertible("cancelled"), false);
assert.equal(notConvertibleMessage({ status: "active" }), "");
assert.equal(
  notConvertibleMessage({ status: "converted", convertedInvoiceNumber: "INV/2026-27/0003" }),
  "This estimate has already been converted to INV/2026-27/0003."
);
assert.equal(notConvertibleMessage({ status: "cancelled" }), "Only active estimates can be converted.");

/* ---------- conversion lines: saved snapshots plus CURRENT HSN and rate ---------- */
let built = buildConversionLines(estimateLines, items(), new Map([[A, "B-17"]]));
assert.deepEqual(built.problems, []);
assert.deepEqual(built.lines, [
  {
    item: A,
    productName: "Crepe 10cm",
    unit: "pcs",
    hsnCode: "3005",
    gstRatePercent: 5,
    quantity: 7,
    pricePaise: 3333,
    taxablePaise: 23331,
    batchReference: "B-17",
  },
  {
    item: B,
    productName: "Gauze Roll",
    unit: "dozen",
    hsnCode: "30059040",
    gstRatePercent: 18,
    quantity: 3,
    pricePaise: 9999,
    taxablePaise: 29997,
    batchReference: "",
  },
]);

// The price comes from the estimate snapshot, never from the item or customer price.
const changedMaster = items();
changedMaster.get(A).pricePaise = 99999;
assert.equal(buildConversionLines(estimateLines, changedMaster).lines[0].pricePaise, 3333);

/* ---------- missing HSN / GST rate blocks, naming the item ---------- */
let noHsn = items();
noHsn.set(A, { productName: "Crepe 10cm", category: "finished_goods", hsnCode: "", gstRatePercent: 5 });
built = buildConversionLines(estimateLines, noHsn);
assert.deepEqual(built.problems, ["Crepe 10cm has no HSN code. Set it in Stock Management before invoicing."]);
assert.equal(built.lines.length, 1, "the complete line is still built");

let noRate = items();
noRate.set(B, { productName: "Gauze Roll", category: "finished_goods", hsnCode: "3005" });
assert.deepEqual(buildConversionLines(estimateLines, noRate).problems, [
  "Gauze Roll has no GST rate. Set it in Stock Management before invoicing.",
]);

const bothMissing = items();
bothMissing.set(A, { productName: "Crepe 10cm", category: "finished_goods" });
bothMissing.set(B, { productName: "Gauze Roll", category: "finished_goods", hsnCode: "3005", gstRatePercent: 12 });
assert.equal(buildConversionLines(estimateLines, bothMissing).problems.length, 2, "every problem is listed");

const notFound = items();
notFound.delete(A);
assert.deepEqual(buildConversionLines(estimateLines, notFound).problems, ["Crepe 10cm was not found."]);

const rawItem = items();
rawItem.set(A, { productName: "Crepe 10cm", category: "raw_material", hsnCode: "3005", gstRatePercent: 5 });
assert.match(buildConversionLines(estimateLines, rawItem).problems[0], /not a Finished Goods/);

/* ---------- conversion tax: GST is ADDED on top of the saved prices ---------- */
built = buildConversionLines(estimateLines, items());
const estimateTotal = 23331 + 29997;
let planned = planConversionTax(built.lines, "intra");
assert.equal(planned.problem, "");
assert.equal(planned.tax.taxablePaise, estimateTotal, "taxable value = the estimate total");
assert.equal(planned.tax.totalPaise, 59900, "invoice total = estimate total + GST + round off");
assert.ok(planned.tax.totalPaise > estimateTotal);
assert.equal(
  planned.tax.taxablePaise + planned.tax.cgstPaise + planned.tax.sgstPaise + planned.tax.igstPaise + planned.tax.roundOffPaise,
  planned.tax.totalPaise
);
assert.deepEqual(planned.tax, computeInvoiceTax(built.lines, "intra"), "same math as invoice creation");

planned = planConversionTax(built.lines, "inter");
assert.equal(planned.tax.igstPaise, 6566);
assert.equal(planned.tax.cgstPaise + planned.tax.sgstPaise, 0);
assert.equal(planned.tax.totalPaise, 59900);

const huge = [{ gstRatePercent: 40, taxablePaise: Number.MAX_SAFE_INTEGER - 5 }];
planned = planConversionTax(huge, "inter");
assert.equal(planned.tax, null);
assert.match(planned.problem, /too large|out of range/);

/* ---------- payment carry-over ---------- */
const payments = [
  { _id: ID(10), amountPaise: 10000, voided: false },
  { _id: ID(11), amountPaise: 5000, voided: true },
  { _id: ID(12), amountPaise: 2500, voided: false, transferred: true },
  { _id: ID(13), amountPaise: 20000, voided: false },
];
let carry = planCarryOver(payments, 59900);
assert.equal(carry.count, 2, "only valid, untransferred payments are carried");
assert.equal(carry.paidPaise, 30000);
assert.deepEqual(carry.payments.map((payment) => payment._id), [ID(10), ID(13)]);
assert.equal(carry.exceedsTotal, false);
assert.equal(planCarryOver(payments, 30000).exceedsTotal, false, "paid exactly the total is fine");
assert.equal(planCarryOver(payments, 29999).exceedsTotal, true, "one paisa over is blocked");
assert.deepEqual(
  planCarryOver([], 100),
  { payments: [], paidPaise: 0, count: 0, exceedsTotal: false },
  "no payments to carry"
);

// 0% GST edge: the grand total can round DOWN below what was paid.
const zeroRate = planConversionTax([{ gstRatePercent: 0, taxablePaise: 10049 }], "intra");
assert.equal(zeroRate.tax.totalPaise, 10000);
assert.equal(planCarryOver([{ amountPaise: 10049, voided: false }], zeroRate.tax.totalPaise).exceedsTotal, true);

/* ---------- converted estimate summary: it has left the estimate ledger ---------- */
const mixedPayments = [
  { amountPaise: 10000, voided: false, transferred: true },
  { amountPaise: 20000, voided: false, transferred: true },
  { amountPaise: 700, voided: true, transferred: false },
];
assert.deepEqual(buildEstimateSummary({ status: "converted", totalPaise: 53328 }, mixedPayments), {
  totalPaise: 53328,
  paidPaise: 0,
  outstandingPaise: 0,
  paymentCount: 0,
  voidedCount: 1,
  transferredPaise: 30000,
  transferredCount: 2,
});
const activeSummary = buildEstimateSummary(
  { status: "active", totalPaise: 5000 },
  [{ amountPaise: 1000, voided: false }, { amountPaise: 500, voided: true }]
);
assert.equal(activeSummary.paidPaise, 1000);
assert.equal(activeSummary.outstandingPaise, 4000, "active estimates keep the 11B math");
assert.equal(activeSummary.transferredPaise, 0);

/* ---------- customer estimate account never includes converted estimates ---------- */
const account = buildEstimateAccount(
  [
    { _id: "active", count: 2, totalPaise: 100000 },
    { _id: "converted", count: 3, totalPaise: 900000 },
    { _id: "cancelled", count: 1, totalPaise: 50000 },
  ],
  [{ _id: null, paidPaise: 40000, count: 2 }]
);
assert.deepEqual(account, {
  activeCount: 2,
  cancelledCount: 1,
  convertedCount: 3,
  totalEstimatedPaise: 100000,
  totalPaidPaise: 40000,
  outstandingPaise: 60000,
  paymentCount: 2,
});
assert.equal(buildEstimateAccount([], []).totalEstimatedPaise, 0);

/* ---------- request validation ---------- */
const today = "2026-11-24";
let result = validateConvertPayload(undefined, today);
assert.equal(result.valid, true, "an empty body converts with defaults");
assert.equal(result.value.invoiceDate.toISOString(), "2026-11-24T00:00:00.000Z");
assert.equal(result.value.notes, "");
assert.equal(result.value.batchByItem.size, 0);

result = validateConvertPayload(
  { invoiceDate: "2026-11-20", notes: " Dispatch ", lines: [{ item: A, batchReference: "  B-1 " }] },
  today
);
assert.equal(result.valid, true, result.message);
assert.equal(result.value.notes, "Dispatch");
assert.equal(result.value.batchByItem.get(A), "B-1");

// Quantities and prices cannot be changed: they are simply never read.
result = validateConvertPayload({ lines: [{ item: A, batchReference: "B", quantity: 99, pricePaise: 1 }] }, today);
assert.equal(result.valid, true);
assert.deepEqual([...result.value.batchByItem.entries()], [[A, "B"]]);

assert.match(validateConvertPayload({ invoiceDate: "2026-11-25" }, today).message, /future/);
assert.equal(validateConvertPayload({ invoiceDate: "2026-02-30" }, today).valid, false);
assert.equal(validateConvertPayload({ notes: "x".repeat(501) }, today).valid, false);
assert.equal(validateConvertPayload({ lines: "nope" }, today).valid, false);
assert.equal(validateConvertPayload({ lines: [{ item: "bad", batchReference: "B" }] }, today).valid, false);
assert.equal(
  validateConvertPayload({ lines: [{ item: A }, { item: A }] }, today).valid,
  false,
  "each product once"
);
assert.equal(
  validateConvertPayload({ lines: [{ item: A, batchReference: "x".repeat(101) }] }, today).valid,
  false
);
assert.equal(validateConvertPayload([], today).valid, false);

/* ---------- model fields ---------- */
const estimateDoc = new Estimate({
  estimateNumber: "EST/2026-27/0001",
  financialYear: "2026-27",
  sequence: 1,
  customer: ID(9),
  customerSnapshot: { name: "Shree" },
  estimateDate: new Date("2026-11-24T00:00:00.000Z"),
  lines: [{ item: A, productName: "Crepe", unit: "pcs", quantity: 3, pricePaise: 100, lineTotalPaise: 300 }],
  totalPaise: 300,
});
assert.equal(estimateDoc.validateSync(), undefined);
assert.equal(estimateDoc.convertedInvoice, null);
assert.equal(estimateDoc.convertedInvoiceNumber, "");
assert.equal(estimateDoc.convertedBy, "");
assert.equal(new Estimate({ ...estimateDoc.toObject(), status: "converted" }).validateSync(), undefined);

const transferredDoc = new EstimatePayment({
  estimate: ID(5),
  customer: ID(9),
  estimateNumber: "EST/2026-27/0001",
  amountPaise: 100,
  paymentDate: new Date("2026-11-24T00:00:00.000Z"),
  method: "cash",
});
assert.equal(transferredDoc.transferred, false);
assert.equal(transferredDoc.voided, false, "transfer is not a void");

const invoicePayment = new InvoicePayment({
  invoice: ID(6),
  customer: ID(9),
  invoiceNumber: "INV/2026-27/0001",
  amountPaise: 100,
  paymentDate: new Date("2026-11-24T00:00:00.000Z"),
  method: "cash",
  carriedFromEstimatePayment: ID(7),
  carriedFromEstimateNumber: "EST/2026-27/0001",
});
assert.equal(invoicePayment.validateSync(), undefined);
assert.ok(
  InvoicePayment.schema
    .indexes()
    .find(([fields, options]) => fields.carriedFromEstimatePayment === 1 && options.unique && options.partialFilterExpression),
  "an estimate payment can be carried over only once"
);
assert.ok(
  Invoice.schema
    .indexes()
    .find(([fields, options]) => fields.sourceEstimate === 1 && options.unique && options.partialFilterExpression),
  "one estimate becomes at most one invoice"
);

console.log("Estimate conversion helpers: all assertions passed.");
