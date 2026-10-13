const mongoose = require("mongoose");
const MaterialReceipt = require("../models/MaterialReceipt");
const SupplierPayment = require("../models/SupplierPayment");

const PAYMENT_METHODS = ["cash", "bank_transfer", "upi", "cheque", "other"];

const parseRupeesToPaise = (value) => {
  const source = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) {
    return { valid: false, message: "Payment amount is invalid." };
  }

  const [whole, fraction = ""] = source.split(".");
  const paise = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(paise) || paise <= 0) {
    return { valid: false, message: "Payment amount must be greater than zero." };
  }

  return { valid: true, value: paise };
};

const parseDateOnly = (value, field = "Payment date") => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return { valid: false, message: `${field} is invalid.` };

  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3])
  ) {
    return { valid: false, message: `${field} is invalid.` };
  }

  return { valid: true, value: date };
};

const cleanOptionalText = (value, field, maximum) => {
  if (value === undefined || value === null) return { valid: true, value: "" };
  if (typeof value !== "string") return { valid: false, message: `${field} must be text.` };
  const cleaned = value.trim();
  if (cleaned.length > maximum) {
    return { valid: false, message: `${field} must be ${maximum} characters or fewer.` };
  }
  return { valid: true, value: cleaned };
};

const calculateOutstandingPaise = (totalPurchasesPaise, totalPaidPaise) =>
  Number(totalPurchasesPaise || 0) - Number(totalPaidPaise || 0);

const canRecordPayment = (outstandingPaise, amountPaise) =>
  Number.isSafeInteger(amountPaise) && amountPaise > 0 && amountPaise <= outstandingPaise;

const getSupplierAccountSummary = async (supplierId, session = null) => {
  const match = { supplier: new mongoose.Types.ObjectId(supplierId) };
  const options = session ? { session } : {};
  const [purchaseRows, paymentRows] = await Promise.all([
    MaterialReceipt.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: "$totalAmountPaise" }, count: { $sum: 1 } } },
    ]).option(options),
    SupplierPayment.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: "$amountPaise" }, count: { $sum: 1 } } },
    ]).option(options),
  ]);

  const totalPurchasesPaise = Number(purchaseRows[0]?.total || 0);
  const totalPaidPaise = Number(paymentRows[0]?.total || 0);
  return {
    totalPurchasesPaise,
    totalPaidPaise,
    outstandingPaise: calculateOutstandingPaise(totalPurchasesPaise, totalPaidPaise),
    receiptCount: Number(purchaseRows[0]?.count || 0),
    paymentCount: Number(paymentRows[0]?.count || 0),
  };
};

module.exports = {
  PAYMENT_METHODS,
  calculateOutstandingPaise,
  canRecordPayment,
  cleanOptionalText,
  getSupplierAccountSummary,
  parseDateOnly,
  parseRupeesToPaise,
};
