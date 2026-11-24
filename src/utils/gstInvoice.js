/*
 * GST invoice math (pure, no DB). The ONLY place invoice tax is calculated;
 * the frontend mirror is preview-only.
 *
 * Prices are EXCLUSIVE of GST. All amounts are integer paise.
 *
 * Algorithm (approved for Step 11C):
 *   1. line taxable = quantity x price (exact).
 *   2. group lines by GST rate; group taxable = sum of its line taxables.
 *   3. tax type from the customer's state code: 09 (Uttar Pradesh, NCH's
 *      state) = CGST + SGST, any other valid state = IGST. No state = blocked.
 *   4. per group, rate in basis points (5% = 500):
 *        CGST + SGST: each half = roundHalfUp(taxable x bp, 20000)  (equal halves)
 *        IGST:        roundHalfUp(taxable x bp, 10000)
 *   5. invoice tax = sum of group taxes.
 *   6. exact = taxable + tax; total = exact rounded to the nearest rupee
 *      (50 paise rounds up); round off = total - exact (-49..+50 paise).
 *   Invariant: taxable + cgst + sgst + igst + roundOff === total.
 */
const {
  GST_RATE_PERCENTS,
  HSN_PATTERN,
  NCH_STATE_CODE,
  isValidStateCode,
} = require("./gst");

const TAX_TYPES = ["intra", "inter"];

const amountError = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** Round half up of n / d for n >= 0 (integers). */
const roundHalfUp = (numerator, denominator) =>
  Math.floor((2 * numerator + denominator) / (2 * denominator));

const rateToBasisPoints = (rate) => Math.round(rate * 100);

/** "intra" (CGST + SGST) for state 09, "inter" (IGST) for other states, null if no valid state. */
const determineTaxType = (stateCode) => {
  if (!isValidStateCode(stateCode)) return null;
  return stateCode === NCH_STATE_CODE ? "intra" : "inter";
};

/** Message naming the product when its tax metadata is missing, or "" when complete. */
const missingTaxMetadataMessage = (item) => {
  if (!item.hsnCode || !HSN_PATTERN.test(item.hsnCode)) {
    return `${item.productName} has no HSN code. Set it in Stock Management before invoicing.`;
  }
  if (
    item.gstRatePercent === undefined ||
    item.gstRatePercent === null ||
    !GST_RATE_PERCENTS.includes(item.gstRatePercent)
  ) {
    return `${item.productName} has no GST rate. Set it in Stock Management before invoicing.`;
  }
  return "";
};

/**
 * lines: [{ gstRatePercent, taxablePaise }]. Returns the full tax breakdown.
 * Throws a 400 error when an amount would leave the safe integer range.
 */
const computeInvoiceTax = (lines, taxType) => {
  if (!TAX_TYPES.includes(taxType)) throw new Error("Unknown tax type.");

  const groups = new Map();
  for (const line of lines) {
    if (!GST_RATE_PERCENTS.includes(line.gstRatePercent)) throw amountError("Invalid GST rate.");
    if (!Number.isSafeInteger(line.taxablePaise) || line.taxablePaise < 0) {
      throw amountError("Invoice amount is out of range.");
    }
    const taxable = (groups.get(line.gstRatePercent) || 0) + line.taxablePaise;
    if (!Number.isSafeInteger(taxable)) throw amountError("Invoice amount is out of range.");
    groups.set(line.gstRatePercent, taxable);
  }

  const taxSummary = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([gstRatePercent, taxablePaise]) => {
      const bp = rateToBasisPoints(gstRatePercent);
      if (!Number.isSafeInteger(taxablePaise * bp * 2 + 20000)) {
        throw amountError("Invoice amount is too large.");
      }
      let cgstPaise = 0;
      let sgstPaise = 0;
      let igstPaise = 0;
      if (taxType === "intra") {
        cgstPaise = roundHalfUp(taxablePaise * bp, 20000);
        sgstPaise = cgstPaise;
      } else {
        igstPaise = roundHalfUp(taxablePaise * bp, 10000);
      }
      return {
        gstRatePercent,
        taxablePaise,
        cgstPaise,
        sgstPaise,
        igstPaise,
        taxPaise: cgstPaise + sgstPaise + igstPaise,
      };
    });

  const sum = (field) => taxSummary.reduce((total, row) => total + row[field], 0);
  const taxablePaise = sum("taxablePaise");
  const cgstPaise = sum("cgstPaise");
  const sgstPaise = sum("sgstPaise");
  const igstPaise = sum("igstPaise");
  const taxTotalPaise = cgstPaise + sgstPaise + igstPaise;
  const exactPaise = taxablePaise + taxTotalPaise;
  if (!Number.isSafeInteger(exactPaise)) throw amountError("Invoice amount is too large.");

  const totalPaise = roundHalfUp(exactPaise, 100) * 100;
  const roundOffPaise = totalPaise - exactPaise;

  return {
    taxSummary,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    taxTotalPaise,
    roundOffPaise,
    totalPaise,
  };
};

/* ---------- amount in words (Indian numbering) ---------- */

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

const belowHundred = (n) =>
  n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;

const belowThousand = (n) => {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : "", rest ? belowHundred(rest) : ""]
    .filter(Boolean)
    .join(" ");
};

/** Whole number in Indian words: 1,00,00,000 -> "One Crore". */
const numberToIndianWords = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) return "";
  if (value === 0) return "Zero";
  const parts = [];
  let rest = value;
  const crore = Math.floor(rest / 10000000);
  rest %= 10000000;
  if (crore) parts.push(`${numberToIndianWords(crore)} Crore`);
  const lakh = Math.floor(rest / 100000);
  rest %= 100000;
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(" ");
};

/** 131800 -> "Rupees One Thousand Three Hundred Eighteen Only". */
const amountInWords = (paise) => {
  if (!Number.isSafeInteger(paise) || paise < 0) return "";
  const rupeesPart = Math.floor(paise / 100);
  const paisePart = paise % 100;
  const words = `Rupees ${numberToIndianWords(rupeesPart)}`;
  return paisePart ? `${words} and ${belowHundred(paisePart)} Paise Only` : `${words} Only`;
};

module.exports = {
  TAX_TYPES,
  amountInWords,
  computeInvoiceTax,
  determineTaxType,
  missingTaxMetadataMessage,
  numberToIndianWords,
  rateToBasisPoints,
  roundHalfUp,
};
