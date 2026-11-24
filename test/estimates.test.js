/*
 * Estimate helpers (no DB): financial year, numbering, money math,
 * payload validation, stock difference on edit, payment and status rules.
 */
const assert = require("node:assert/strict");
const Estimate = require("../src/models/Estimate");
const EstimatePayment = require("../src/models/EstimatePayment");
const StockMovement = require("../src/models/StockMovement");
const {
  buildSummary,
  canCancelEstimate,
  canEditEstimate,
  canRecordPayment,
  canVoidPayment,
  computeStockDiff,
  formatEstimateNumber,
  getBusinessToday,
  getFinancialYear,
  lineTotal,
  parseBusinessDate,
  sumTotal,
  summarizePayments,
  validateCreatePayload,
  validateEditPayload,
  validateEstimateLines,
  validatePaymentPayload,
  validateReason,
} = require("../src/utils/estimates");

const ID = (n) => `64b0000000000000000000${String(n).padStart(2, "0")}`;

/* ---------- financial year ---------- */
assert.equal(getFinancialYear("2027-03-31"), "2026-27");
assert.equal(getFinancialYear("2027-04-01"), "2027-28");
assert.equal(getFinancialYear("2026-04-01"), "2026-27");
assert.equal(getFinancialYear("2026-03-31"), "2025-26");
assert.equal(getFinancialYear("2027-01-15"), "2026-27");
assert.equal(getFinancialYear("2026-12-31"), "2026-27");
assert.equal(getFinancialYear("2028-02-29"), "2027-28", "leap day");
assert.equal(getFinancialYear("2099-04-01"), "2099-00", "century wrap");
assert.equal(getFinancialYear(new Date("2027-04-01T00:00:00.000Z")), "2027-28", "Date input");
assert.equal(getFinancialYear(new Date("2027-03-31T00:00:00.000Z")), "2026-27");
assert.equal(getFinancialYear("bad"), "");

/* ---------- numbering ---------- */
assert.equal(formatEstimateNumber("2026-27", 1), "EST/2026-27/0001");
assert.equal(formatEstimateNumber("2026-27", 9999), "EST/2026-27/9999");
assert.equal(formatEstimateNumber("2026-27", 10000), "EST/2026-27/10000");

/* ---------- business dates (Asia/Kolkata) ---------- */
// 2027-03-31 20:00 UTC is already 1 April in India.
assert.equal(getBusinessToday(new Date("2027-03-31T20:00:00.000Z")), "2027-04-01");
assert.equal(getBusinessToday(new Date("2027-03-31T18:29:00.000Z")), "2027-03-31");
assert.equal(parseBusinessDate("2026-11-24", "Estimate date", "2026-11-24").valid, true);
assert.equal(parseBusinessDate("2026-11-25", "Estimate date", "2026-11-24").valid, false);
assert.equal(parseBusinessDate("2026-02-30", "Estimate date", "2026-11-24").valid, false);
assert.equal(
  parseBusinessDate("2026-11-20", "Estimate date", "2026-11-24").value.toISOString(),
  "2026-11-20T00:00:00.000Z"
);

/* ---------- money ---------- */
assert.equal(lineTotal(3, 12550), 37650);
assert.equal(lineTotal(100000, 100000000), 10000000000000);
assert.throws(() => lineTotal(1.5, 100));
assert.throws(() => lineTotal(Number.MAX_SAFE_INTEGER, 2));
assert.equal(sumTotal([{ lineTotalPaise: 37650 }, { lineTotalPaise: 1 }]), 37651);
assert.equal(sumTotal([]), 0);
assert.throws(() => sumTotal([{ lineTotalPaise: Number.MAX_SAFE_INTEGER }, { lineTotalPaise: 1 }]));

/* ---------- line validation ---------- */
let result = validateEstimateLines([{ item: ID(1), quantity: 5 }, { item: ID(2), quantity: "3" }]);
assert.equal(result.valid, true, result.message);
assert.deepEqual(result.value, [
  { item: ID(1), quantity: 5, reprice: false },
  { item: ID(2), quantity: 3, reprice: false },
]);
assert.equal(validateEstimateLines([]).valid, false, "empty");
assert.equal(validateEstimateLines(undefined).valid, false);
assert.equal(validateEstimateLines([{ item: ID(1), quantity: 0 }]).valid, false, "zero qty");
assert.equal(validateEstimateLines([{ item: ID(1), quantity: 1.5 }]).valid, false, "decimal qty");
assert.equal(validateEstimateLines([{ item: ID(1), quantity: "1.5" }]).valid, false);
assert.equal(validateEstimateLines([{ item: ID(1), quantity: 100001 }]).valid, false, "too large");
assert.equal(validateEstimateLines([{ item: ID(1), quantity: -2 }]).valid, false);
assert.equal(validateEstimateLines([{ item: "abc", quantity: 1 }]).valid, false, "bad id");
assert.match(
  validateEstimateLines([{ item: ID(1), quantity: 1 }, { item: ID(1), quantity: 2 }]).message,
  /only once/
);
assert.equal(
  validateEstimateLines(Array.from({ length: 101 }, (_, index) => ({ item: ID(index), quantity: 1 }))).valid,
  false,
  "more than 100 lines"
);
assert.equal(validateEstimateLines([{ item: ID(1), quantity: 1, reprice: true }]).valid, false, "no reprice on create");
assert.equal(
  validateEstimateLines([{ item: ID(1), quantity: 1, reprice: true }], { allowReprice: true }).value[0].reprice,
  true
);
assert.equal(
  validateEstimateLines([{ item: ID(1), quantity: 1, reprice: "yes" }], { allowReprice: true }).valid,
  false
);

/* ---------- create / edit / payment payloads ---------- */
const today = "2026-11-24";
result = validateCreatePayload({ customer: ID(9), estimateDate: "2026-11-24", lines: [{ item: ID(1), quantity: 2 }] }, today);
assert.equal(result.valid, true, result.message);
assert.equal(result.value.estimateDate.toISOString(), "2026-11-24T00:00:00.000Z");
assert.equal(validateCreatePayload({ customer: ID(9), lines: [{ item: ID(1), quantity: 2 }] }, today).value.estimateDate.toISOString().slice(0, 10), today, "defaults to today");
assert.equal(validateCreatePayload({ customer: "x", lines: [{ item: ID(1), quantity: 2 }] }, today).valid, false);
assert.match(validateCreatePayload({ customer: ID(9), estimateDate: "2026-11-25", lines: [{ item: ID(1), quantity: 2 }] }, today).message, /future/);
assert.equal(validateCreatePayload({ customer: ID(9), lines: [{ item: ID(1), quantity: 2 }], notes: "x".repeat(501) }, today).valid, false);

assert.equal(validateEditPayload({ lines: [{ item: ID(1), quantity: 2, reprice: true }] }).valid, true);
assert.match(validateEditPayload({ customer: ID(9), lines: [{ item: ID(1), quantity: 2 }] }).message, /cannot be changed/);
assert.match(validateEditPayload({ estimateDate: "2026-11-20", lines: [{ item: ID(1), quantity: 2 }] }).message, /cannot be changed/);

result = validatePaymentPayload({ amount: "250.50", paymentDate: "2026-11-24", method: "upi", reference: " UTR1 " }, today);
assert.equal(result.valid, true, result.message);
assert.equal(result.value.amountPaise, 25050);
assert.equal(result.value.reference, "UTR1");
assert.equal(validatePaymentPayload({ amount: "0", paymentDate: today, method: "cash" }, today).valid, false);
assert.equal(validatePaymentPayload({ amount: "1.234", paymentDate: today, method: "cash" }, today).valid, false);
assert.equal(validatePaymentPayload({ amount: "10", paymentDate: "2026-11-25", method: "cash" }, today).valid, false, "future payment");
assert.equal(validatePaymentPayload({ amount: "10", paymentDate: today, method: "card" }, today).valid, false, "bad method");
["cash", "upi", "bank_transfer", "cheque", "other"].forEach((method) =>
  assert.equal(validatePaymentPayload({ amount: "10", paymentDate: today, method }, today).valid, true, method)
);

assert.equal(validateReason("  Wrong   customer ").value, "Wrong customer");
assert.equal(validateReason("").valid, false);
assert.equal(validateReason("   ").valid, false);
assert.equal(validateReason(undefined).valid, false);
assert.equal(validateReason("x".repeat(251)).valid, false);

/* ---------- stock difference on edit ---------- */
const A = ID(1);
const B = ID(2);
const C = ID(3);
assert.deepEqual(computeStockDiff([{ item: A, quantity: 5 }], [{ item: A, quantity: 5 }]), [], "unchanged");
assert.deepEqual(computeStockDiff([{ item: A, quantity: 5 }], [{ item: A, quantity: 8 }]), [{ item: A, delta: 3 }], "increase");
assert.deepEqual(computeStockDiff([{ item: A, quantity: 5 }], [{ item: A, quantity: 2 }]), [{ item: A, delta: -3 }], "decrease");
assert.deepEqual(computeStockDiff([{ item: A, quantity: 5 }], [{ item: A, quantity: 5 }, { item: B, quantity: 4 }]), [{ item: B, delta: 4 }], "add");
assert.deepEqual(computeStockDiff([{ item: A, quantity: 5 }, { item: B, quantity: 4 }], [{ item: A, quantity: 5 }]), [{ item: B, delta: -4 }], "remove");
assert.deepEqual(
  computeStockDiff(
    [{ item: C, quantity: 1 }, { item: A, quantity: 5 }, { item: B, quantity: 4 }],
    [{ item: B, quantity: 6 }, { item: A, quantity: 5 }, { item: { toString: () => C }, quantity: 0 + 1 }]
  ),
  [{ item: B, delta: 2 }],
  "mixed: only real changes, ObjectId-like keys"
);
assert.deepEqual(
  computeStockDiff([{ item: C, quantity: 2 }, { item: A, quantity: 1 }], [{ item: B, quantity: 1 }]),
  [{ item: A, delta: -1 }, { item: B, delta: 1 }, { item: C, delta: -2 }],
  "sorted by item id"
);

/* ---------- payments ---------- */
const payments = [
  { amountPaise: 1000, voided: false },
  { amountPaise: 500, voided: true },
  { amountPaise: 250, voided: false },
];
assert.deepEqual(summarizePayments(payments), { paidPaise: 1250, paymentCount: 2, voidedCount: 1 });
assert.deepEqual(buildSummary(5000, payments), {
  totalPaise: 5000,
  paidPaise: 1250,
  outstandingPaise: 3750,
  paymentCount: 2,
  voidedCount: 1,
});
assert.equal(canRecordPayment(3750, 3750), true, "exact outstanding");
assert.equal(canRecordPayment(3750, 3751), false, "one paisa over");
assert.equal(canRecordPayment(0, 1), false, "nothing outstanding");
assert.equal(canRecordPayment(3750, 0), false);
assert.equal(canRecordPayment(3750, 1.5), false);

assert.equal(canVoidPayment({ voided: false }, "active"), true);
assert.equal(canVoidPayment({ voided: true }, "active"), false, "already voided");
assert.equal(canVoidPayment({ voided: false }, "cancelled"), false, "estimate not active");
assert.equal(canVoidPayment(null, "active"), false);

/* ---------- status transitions ---------- */
assert.equal(canEditEstimate("active"), true);
assert.equal(canEditEstimate("cancelled"), false);
assert.equal(canEditEstimate("converted"), false);
assert.equal(canCancelEstimate("active", 0), true);
assert.equal(canCancelEstimate("active", 1), false, "payments block cancel");
assert.equal(canCancelEstimate("cancelled", 0), false);

/* ---------- schemas ---------- */
assert.ok(StockMovement.schema.path("movementType").enumValues.includes("estimate_out"));
assert.ok(StockMovement.schema.path("movementType").enumValues.includes("estimate_return"));
assert.ok(StockMovement.schema.path("referenceType").enumValues.includes("estimate"));

const estimateDoc = new Estimate({
  estimateNumber: "EST/2026-27/0001",
  financialYear: "2026-27",
  sequence: 1,
  customer: ID(9),
  customerSnapshot: { name: "Shree Medicals" },
  estimateDate: new Date("2026-11-24T00:00:00.000Z"),
  lines: [{ item: A, productName: "Crepe", unit: "pcs", quantity: 3, pricePaise: 12550, lineTotalPaise: 37650 }],
  totalPaise: 37650,
});
assert.equal(estimateDoc.validateSync(), undefined);
assert.equal(estimateDoc.status, "active");
assert.equal(estimateDoc.convertedInvoice, null, "reserved for 11D");
const json = JSON.stringify(estimateDoc.toJSON()).toLowerCase();
assert.equal(json.includes("gst") || json.includes("hsn"), false, "no GST or HSN on an estimate");
assert.ok(new Estimate({ ...estimateDoc.toObject(), lines: [] }).validateSync()?.errors?.lines, "needs lines");
assert.ok(
  new Estimate({ ...estimateDoc.toObject(), status: "draft" }).validateSync()?.errors?.status,
  "unknown status rejected"
);
const uniqueNumber = Estimate.schema.indexes().find(([fields, options]) => fields.estimateNumber === 1 && options.unique);
assert.ok(uniqueNumber, "unique estimate number index");

const paymentDoc = new EstimatePayment({
  estimate: ID(5),
  customer: ID(9),
  estimateNumber: "EST/2026-27/0001",
  amountPaise: 100,
  paymentDate: new Date("2026-11-24T00:00:00.000Z"),
  method: "cash",
});
assert.equal(paymentDoc.validateSync(), undefined);
assert.equal(paymentDoc.voided, false);
assert.ok(new EstimatePayment({ ...paymentDoc.toObject(), amountPaise: 0 }).validateSync()?.errors?.amountPaise);
assert.ok(new EstimatePayment({ ...paymentDoc.toObject(), method: "card" }).validateSync()?.errors?.method);

console.log("Estimate helpers: all assertions passed.");
