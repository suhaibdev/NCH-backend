/*
 * NCH seller details printed on every GST invoice and snapshotted onto each
 * invoice at creation (old invoices never change when these are edited).
 *
 * PUBLIC details only. Fill in the confirmed values below. Until the legal
 * name, address and a valid GSTIN starting with 09 are set, invoice creation
 * is blocked with "Seller details are not configured".
 *
 * Bank details are NOT stored here: they are read from environment variables
 * (see .env.example). If any required bank variable is missing, the bank block
 * is simply left off the invoice.
 */
const { NCH_STATE_CODE, getStateName, isValidGstin } = require("../utils/gst");

const SELLER_PROFILE = Object.freeze({
  legalName: "", // e.g. "NEW CALCUTTA HANDLOOM"
  tradeName: "", // optional, if different from the legal name
  addressLine1: "",
  addressLine2: "",
  city: "",
  pincode: "",
  gstin: "", // must start with 09 (Uttar Pradesh)
  pan: "", // optional
  phone: "",
  email: "",
  declaration:
    "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
  signatoryLabel: "Authorised Signatory",
});

const BANK_ENV = Object.freeze({
  accountName: "SELLER_BANK_ACCOUNT_NAME",
  accountNumber: "SELLER_BANK_ACCOUNT_NUMBER",
  ifsc: "SELLER_BANK_IFSC",
  bankName: "SELLER_BANK_NAME",
  branch: "SELLER_BANK_BRANCH", // optional
});

const REQUIRED_BANK_FIELDS = ["accountName", "accountNumber", "ifsc", "bankName"];

const clean = (value) => (typeof value === "string" ? value.trim() : "");

/** True when the profile can legally appear on a GST invoice. */
const isSellerConfigured = (profile = SELLER_PROFILE) =>
  Boolean(clean(profile.legalName)) &&
  Boolean(clean(profile.addressLine1)) &&
  Boolean(clean(profile.city)) &&
  /^\d{6}$/.test(clean(profile.pincode)) &&
  isValidGstin(clean(profile.gstin)) &&
  clean(profile.gstin).startsWith(NCH_STATE_CODE);

/** Bank block from the environment, or null when any required value is missing. */
const readBankDetails = (env = process.env) => {
  const bank = Object.fromEntries(
    Object.entries(BANK_ENV).map(([field, variable]) => [field, clean(env[variable])])
  );
  return REQUIRED_BANK_FIELDS.every((field) => bank[field]) ? bank : null;
};

/** Snapshot stored on each new invoice. */
const getSellerSnapshot = (profile = SELLER_PROFILE, env = process.env) => ({
  legalName: clean(profile.legalName),
  tradeName: clean(profile.tradeName),
  addressLine1: clean(profile.addressLine1),
  addressLine2: clean(profile.addressLine2),
  city: clean(profile.city),
  pincode: clean(profile.pincode),
  stateCode: NCH_STATE_CODE,
  stateName: getStateName(NCH_STATE_CODE),
  gstin: clean(profile.gstin),
  pan: clean(profile.pan),
  phone: clean(profile.phone),
  email: clean(profile.email),
  declaration: clean(profile.declaration),
  signatoryLabel: clean(profile.signatoryLabel) || "Authorised Signatory",
  bank: readBankDetails(env),
});

module.exports = {
  BANK_ENV,
  SELLER_PROFILE,
  getSellerSnapshot,
  isSellerConfigured,
  readBankDetails,
};
