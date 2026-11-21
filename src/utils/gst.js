/*
 * GST helpers shared by customers, suppliers and Finished Goods tax metadata.
 * Pure functions only (no DB) so they can be unit-tested with node:assert.
 */

// Standard 15-character GSTIN structure (same rule suppliers have always used).
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// NCH is registered in Uttar Pradesh.
const NCH_STATE_CODE = "09";

/*
 * Official GST state codes currently in use.
 * 25 (old Daman and Diu, merged into 26), 28 (old Andhra Pradesh) and
 * 99 (Centre Jurisdiction) are intentionally not accepted.
 */
const STATE_CODES = Object.freeze({
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  10: "Bihar",
  11: "Sikkim",
  12: "Arunachal Pradesh",
  13: "Nagaland",
  14: "Manipur",
  15: "Mizoram",
  16: "Tripura",
  17: "Meghalaya",
  18: "Assam",
  19: "West Bengal",
  20: "Jharkhand",
  21: "Odisha",
  22: "Chhattisgarh",
  23: "Madhya Pradesh",
  24: "Gujarat",
  26: "Dadra and Nagar Haveli and Daman and Diu",
  27: "Maharashtra",
  29: "Karnataka",
  30: "Goa",
  31: "Lakshadweep",
  32: "Kerala",
  33: "Tamil Nadu",
  34: "Puducherry",
  35: "Andaman and Nicobar Islands",
  36: "Telangana",
  37: "Andhra Pradesh",
  38: "Ladakh",
  97: "Other Territory",
});

// Allowed GST rates (percent) for Finished Goods. Default 5.
const GST_RATE_PERCENTS = Object.freeze([0, 0.25, 3, 5, 18, 40]);
const DEFAULT_GST_RATE_PERCENT = 5;

const HSN_PATTERN = /^\d{4,8}$/;

const isValidStateCode = (code) =>
  typeof code === "string" && /^\d{2}$/.test(code) && Object.prototype.hasOwnProperty.call(STATE_CODES, code);

const isValidGstin = (value) =>
  typeof value === "string" && GSTIN_PATTERN.test(value) && isValidStateCode(value.slice(0, 2));

/** Returns the 2-digit state code of a valid GSTIN, or "" when it is not valid. */
const stateCodeFromGstin = (value) => (isValidGstin(value) ? value.slice(0, 2) : "");

const getStateName = (code) => (isValidStateCode(code) ? STATE_CODES[code] : "");

const isValidGstRate = (value) =>
  typeof value === "number" && GST_RATE_PERCENTS.includes(value);

const validateHsnCode = (value) => {
  if (value === undefined || value === null || value === "") return { valid: true, value: "" };
  if (typeof value !== "string" && typeof value !== "number") {
    return { valid: false, message: "HSN code must be 4 to 8 digits." };
  }
  const cleaned = String(value).trim();
  if (cleaned === "") return { valid: true, value: "" };
  if (!HSN_PATTERN.test(cleaned)) {
    return { valid: false, message: "HSN code must be 4 to 8 digits." };
  }
  return { valid: true, value: cleaned };
};

const parseGstRate = (value) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!isValidGstRate(number)) {
    return {
      valid: false,
      message: `GST rate must be one of ${GST_RATE_PERCENTS.join(", ")} percent.`,
    };
  }
  return { valid: true, value: number };
};

/**
 * Validates Finished Goods tax metadata.
 * Returns { valid, value: { hsnCode?, gstRatePercent? } } containing only the
 * fields that were sent. Any other category that sends tax fields is rejected.
 */
const validateTaxMetadata = ({ category, hsnCode, gstRatePercent }) => {
  const sentHsn = hsnCode !== undefined;
  const sentRate = gstRatePercent !== undefined;

  if (category !== "finished_goods") {
    const hasValue =
      (sentHsn && hsnCode !== null && String(hsnCode).trim() !== "") ||
      (sentRate && gstRatePercent !== null && gstRatePercent !== "");
    if (hasValue) {
      return { valid: false, message: "HSN code and GST rate apply only to Finished Goods." };
    }
    return { valid: true, value: {} };
  }

  const value = {};
  if (sentHsn) {
    const hsn = validateHsnCode(hsnCode);
    if (!hsn.valid) return hsn;
    value.hsnCode = hsn.value;
  }
  if (sentRate) {
    const rate = parseGstRate(gstRatePercent);
    if (!rate.valid) return rate;
    value.gstRatePercent = rate.value;
  }
  return { valid: true, value };
};

module.exports = {
  DEFAULT_GST_RATE_PERCENT,
  GSTIN_PATTERN,
  GST_RATE_PERCENTS,
  HSN_PATTERN,
  NCH_STATE_CODE,
  STATE_CODES,
  getStateName,
  isValidGstRate,
  isValidGstin,
  isValidStateCode,
  parseGstRate,
  stateCodeFromGstin,
  validateHsnCode,
  validateTaxMetadata,
};
