/*
 * GST invoice math (no DB): tax type, per-rate grouping, CGST/SGST halves,
 * IGST, round-off, exact reconciliation, amount in words, numbering, seller
 * profile and the Invoice schema.
 */
const assert = require("node:assert/strict");
const Invoice = require("../src/models/Invoice");
const StockMovement = require("../src/models/StockMovement");
const {
  amountInWords,
  computeInvoiceTax,
  determineTaxType,
  missingTaxMetadataMessage,
  numberToIndianWords,
  rateToBasisPoints,
  roundHalfUp,
} = require("../src/utils/gstInvoice");
const {
  formatDocumentNumber,
  getFinancialYear,
  validateDocumentLines,
} = require("../src/utils/salesDocuments");
const {
  getSellerSnapshot,
  isSellerConfigured,
  readBankDetails,
} = require("../src/config/sellerProfile");

const line = (quantity, pricePaise, gstRatePercent) => ({
  gstRatePercent,
  taxablePaise: quantity * pricePaise,
});

const reconciles = (tax) =>
  tax.taxablePaise + tax.cgstPaise + tax.sgstPaise + tax.igstPaise + tax.roundOffPaise === tax.totalPaise;

/* ---------- tax type (customer state code only) ---------- */
assert.equal(determineTaxType("09"), "intra", "Uttar Pradesh: CGST + SGST");
assert.equal(determineTaxType("27"), "inter", "Maharashtra: IGST");
assert.equal(determineTaxType("07"), "inter", "Delhi: IGST");
assert.equal(determineTaxType("97"), "inter", "Other Territory: IGST");
assert.equal(determineTaxType(""), null, "no state blocks the invoice");
assert.equal(determineTaxType(undefined), null);
assert.equal(determineTaxType("25"), null, "retired code is not valid");
assert.equal(determineTaxType("9"), null);

/* ---------- rounding primitives ---------- */
assert.equal(roundHalfUp(31375, 10), 3138, "x.5 rounds up");
assert.equal(roundHalfUp(31374, 10), 3137);
assert.equal(roundHalfUp(0, 100), 0);
assert.deepEqual([0, 0.25, 3, 5, 18, 40].map(rateToBasisPoints), [0, 25, 300, 500, 1800, 4000]);

/* ---------- worked example 1: single rate, UP buyer ---------- */
let tax = computeInvoiceTax([line(10, 12550, 5)], "intra");
assert.deepEqual(tax, {
  taxSummary: [
    { gstRatePercent: 5, taxablePaise: 125500, cgstPaise: 3138, sgstPaise: 3138, igstPaise: 0, taxPaise: 6276 },
  ],
  taxablePaise: 125500,
  cgstPaise: 3138,
  sgstPaise: 3138,
  igstPaise: 0,
  taxTotalPaise: 6276,
  roundOffPaise: 24,
  totalPaise: 131800,
});
assert.ok(reconciles(tax));

/* ---------- worked example 2: mixed rates, UP buyer ---------- */
const mixed = [line(7, 3333, 5), line(3, 9999, 18)];
tax = computeInvoiceTax(mixed, "intra");
assert.deepEqual(tax.taxSummary, [
  { gstRatePercent: 5, taxablePaise: 23331, cgstPaise: 583, sgstPaise: 583, igstPaise: 0, taxPaise: 1166 },
  { gstRatePercent: 18, taxablePaise: 29997, cgstPaise: 2700, sgstPaise: 2700, igstPaise: 0, taxPaise: 5400 },
]);
assert.equal(tax.taxablePaise, 53328);
assert.equal(tax.taxTotalPaise, 6566);
assert.equal(tax.roundOffPaise, 6);
assert.equal(tax.totalPaise, 59900);
assert.ok(reconciles(tax));

/* ---------- worked example 3: same lines, interstate (IGST) ---------- */
tax = computeInvoiceTax(mixed, "inter");
assert.deepEqual(tax.taxSummary, [
  { gstRatePercent: 5, taxablePaise: 23331, cgstPaise: 0, sgstPaise: 0, igstPaise: 1167, taxPaise: 1167 },
  { gstRatePercent: 18, taxablePaise: 29997, cgstPaise: 0, sgstPaise: 0, igstPaise: 5399, taxPaise: 5399 },
]);
assert.equal(tax.igstPaise, 6566);
assert.equal(tax.cgstPaise + tax.sgstPaise, 0);
assert.equal(tax.roundOffPaise, 6);
assert.equal(tax.totalPaise, 59900);
assert.ok(reconciles(tax));

/* ---------- worked example 4: odd half at 0.25%, round off down ---------- */
tax = computeInvoiceTax([line(1, 10000, 0.25)], "intra");
assert.equal(tax.cgstPaise, 13);
assert.equal(tax.sgstPaise, 13, "halves equal even when half the rate is 0.125%");
assert.equal(tax.roundOffPaise, -26);
assert.equal(tax.totalPaise, 10000);
assert.ok(reconciles(tax));

/* ---------- worked example 5: 0% with 50 paise rounds up ---------- */
tax = computeInvoiceTax([line(1, 9950, 0)], "inter");
assert.equal(tax.taxTotalPaise, 0);
assert.equal(tax.roundOffPaise, 50, ".50 rounds up");
assert.equal(tax.totalPaise, 10000);

/* ---------- grouping: same rate on many lines is taxed once ---------- */
// Per line: 3 x round(101 x 500 / 20000) = 3 x 3 = 9 per half; per group: round(303 x 500 / 20000) = 8.
tax = computeInvoiceTax([line(1, 101, 5), { gstRatePercent: 5, taxablePaise: 101 }, line(1, 101, 5)], "intra");
assert.equal(tax.taxSummary.length, 1);
assert.equal(tax.cgstPaise, 8, "tax is on the group total, not per line");

/* ---------- round off is always -49..+50 and totals reconcile ---------- */
let seed = 42;
const random = (max) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % max;
};
const RATES = [0, 0.25, 3, 5, 18, 40];
for (let run = 0; run < 500; run += 1) {
  const lines = Array.from({ length: 1 + random(6) }, () =>
    line(1 + random(500), 1 + random(500000), RATES[random(RATES.length)])
  );
  for (const taxType of ["intra", "inter"]) {
    tax = computeInvoiceTax(lines, taxType);
    assert.ok(reconciles(tax), `run ${run} ${taxType} reconciles`);
    assert.ok(tax.roundOffPaise >= -49 && tax.roundOffPaise <= 50, "round off range");
    assert.equal(tax.totalPaise % 100, 0, "total is whole rupees");
    assert.equal(tax.cgstPaise, tax.sgstPaise, "CGST equals SGST");
    const sumOf = (field) => tax.taxSummary.reduce((total, row) => total + row[field], 0);
    ["taxablePaise", "cgstPaise", "sgstPaise", "igstPaise"].forEach((field) =>
      assert.equal(sumOf(field), tax[field], `group ${field} sums to the invoice`)
    );
    assert.equal(sumOf("taxPaise"), tax.taxTotalPaise);
    assert.equal(
      tax.taxablePaise,
      lines.reduce((total, entry) => total + entry.taxablePaise, 0)
    );
  }
}

/* ---------- guards ---------- */
assert.throws(() => computeInvoiceTax([line(1, 100, 12)], "intra"), /Invalid GST rate/);
assert.throws(() => computeInvoiceTax([line(1, 100, 5)], "local"));
assert.throws(
  () => computeInvoiceTax([{ gstRatePercent: 40, taxablePaise: Number.MAX_SAFE_INTEGER - 5 }], "inter"),
  (err) => err.statusCode === 400
);

/* ---------- missing tax metadata blocks invoicing ---------- */
assert.equal(
  missingTaxMetadataMessage({ productName: "Crepe 10cm", hsnCode: "", gstRatePercent: 5 }),
  "Crepe 10cm has no HSN code. Set it in Stock Management before invoicing."
);
assert.equal(
  missingTaxMetadataMessage({ productName: "Crepe 10cm", hsnCode: "3005" }),
  "Crepe 10cm has no GST rate. Set it in Stock Management before invoicing.",
  "no silent 5% default for invoices"
);
assert.equal(missingTaxMetadataMessage({ productName: "X", hsnCode: "3005", gstRatePercent: 12 }) !== "", true);
assert.equal(missingTaxMetadataMessage({ productName: "X", hsnCode: "30059040", gstRatePercent: 0 }), "");

/* ---------- amount in words (Indian numbering) ---------- */
assert.equal(amountInWords(131800), "Rupees One Thousand Three Hundred Eighteen Only");
assert.equal(amountInWords(1000000050), "Rupees One Crore and Fifty Paise Only");
assert.equal(amountInWords(59900), "Rupees Five Hundred Ninety Nine Only");
assert.equal(amountInWords(0), "Rupees Zero Only");
assert.equal(numberToIndianWords(1234567), "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven");
assert.equal(numberToIndianWords(250000000), "Twenty Five Crore");

/* ---------- numbering ---------- */
assert.equal(formatDocumentNumber("INV", getFinancialYear("2027-03-31"), 1), "INV/2026-27/0001");
assert.equal(formatDocumentNumber("INV", getFinancialYear("2027-04-01"), 1), "INV/2027-28/0001");
assert.equal(formatDocumentNumber("INV", "2026-27", 12345), "INV/2026-27/12345");

/* ---------- batch reference on invoice lines ---------- */
const ID = "64b000000000000000000001";
let result = validateDocumentLines([{ item: ID, quantity: 2, batchReference: "  B-17  " }], {
  allowBatchReference: true,
  noun: "an invoice",
});
assert.equal(result.value[0].batchReference, "B-17");
assert.equal(
  validateDocumentLines([{ item: ID, quantity: 2, batchReference: "x".repeat(101) }], { allowBatchReference: true }).valid,
  false
);
result = validateDocumentLines([{ item: ID, quantity: 2, batchReference: "B-17" }], { noun: "an estimate" });
assert.equal("batchReference" in result.value[0], false, "estimates ignore batch references");

/* ---------- seller profile ---------- */
const seller = {
  legalName: "NEW CALCUTTA HANDLOOM",
  addressLine1: "1 Mill Road",
  city: "Kanpur",
  pincode: "208001",
  gstin: "09AAACH7409R1ZZ",
};
assert.equal(isSellerConfigured(seller), true);
assert.equal(isSellerConfigured({ ...seller, gstin: "27AAPFU0939F1ZV" }), false, "GSTIN must be from UP");
assert.equal(isSellerConfigured({ ...seller, legalName: " " }), false);
assert.equal(isSellerConfigured({ ...seller, pincode: "2080" }), false);
assert.equal(isSellerConfigured(), false, "placeholders block invoices until configured");

const bankEnv = {
  SELLER_BANK_ACCOUNT_NAME: "NCH",
  SELLER_BANK_ACCOUNT_NUMBER: "000111222",
  SELLER_BANK_IFSC: "SBIN0000001",
  SELLER_BANK_NAME: "State Bank",
};
assert.deepEqual(readBankDetails(bankEnv), {
  accountName: "NCH",
  accountNumber: "000111222",
  ifsc: "SBIN0000001",
  bankName: "State Bank",
  branch: "",
});
assert.equal(readBankDetails({ ...bankEnv, SELLER_BANK_IFSC: "" }), null, "missing bank env omits the block");
assert.equal(readBankDetails({}), null);
const snapshot = getSellerSnapshot(seller, {});
assert.equal(snapshot.stateCode, "09");
assert.equal(snapshot.stateName, "Uttar Pradesh");
assert.equal(snapshot.bank, null);
assert.equal(getSellerSnapshot(seller, bankEnv).bank.bankName, "State Bank");

/* ---------- schemas ---------- */
assert.ok(StockMovement.schema.path("movementType").enumValues.includes("invoice_out"));
assert.ok(StockMovement.schema.path("movementType").enumValues.includes("invoice_return"));
assert.ok(StockMovement.schema.path("referenceType").enumValues.includes("invoice"));
const indexes = Invoice.schema.indexes();
assert.ok(indexes.find(([fields, options]) => fields.invoiceNumber === 1 && options.unique));
assert.ok(
  indexes.find(([fields, options]) => fields.sourceEstimate === 1 && options.unique && options.partialFilterExpression),
  "one estimate -> at most one invoice (11D)"
);
const invoiceTax = computeInvoiceTax(mixed, "intra");
const invoiceDoc = new Invoice({
  invoiceNumber: "INV/2026-27/0001",
  financialYear: "2026-27",
  sequence: 1,
  customer: ID,
  customerSnapshot: { name: "Shree Medicals", stateCode: "09" },
  seller: getSellerSnapshot(seller, {}),
  invoiceDate: new Date("2026-11-24T00:00:00.000Z"),
  taxType: "intra",
  placeOfSupplyStateCode: "09",
  lines: [
    { item: ID, productName: "Crepe", unit: "pcs", hsnCode: "3005", gstRatePercent: 5, quantity: 7, pricePaise: 3333, taxablePaise: 23331 },
  ],
  ...invoiceTax,
});
assert.equal(invoiceDoc.validateSync(), undefined);
assert.equal(invoiceDoc.status, "active");
assert.equal(invoiceDoc.sourceEstimate, null);
assert.ok(new Invoice({ ...invoiceDoc.toObject(), roundOffPaise: 51 }).validateSync()?.errors?.roundOffPaise);
assert.ok(new Invoice({ ...invoiceDoc.toObject(), status: "cancelled" }).validateSync()?.errors?.status);

console.log("GST invoice math: all assertions passed.");
