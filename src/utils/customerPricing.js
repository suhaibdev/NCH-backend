/*
 * Customer-specific product pricing helpers (pure, no DB).
 * Prices are stored as integer paise, per the item's stock unit.
 */
const { parseRupeesToPaise } = require("./supplierAccounting");

// Guard against typos: Rs 10,00,000.00 per unit.
const MAX_PRICE_PAISE = 100_000_000;

/** Converts a rupee value ("125.50", 125.5) into integer paise. */
const parsePricePaise = (value) => {
  if (value === undefined || value === null || value === "") {
    return { valid: false, message: "Price is required." };
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return { valid: false, message: "Price is invalid." };
  }
  const result = parseRupeesToPaise(value, "Price");
  if (!result.valid) return result;
  if (result.value > MAX_PRICE_PAISE) {
    return { valid: false, message: "Price cannot exceed Rs 10,00,000 per unit." };
  }
  return result;
};

const isValidPricePaise = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= MAX_PRICE_PAISE;

/** 12550 -> "125.50" */
const paiseToRupeesString = (paise) => {
  if (!Number.isSafeInteger(paise) || paise < 0) return "";
  const whole = Math.floor(paise / 100);
  const fraction = String(paise % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
};

/** Only Finished Goods may be priced for a customer. */
const isAssignableItem = (item) => Boolean(item) && item.category === "finished_goods";

module.exports = {
  MAX_PRICE_PAISE,
  isAssignableItem,
  isValidPricePaise,
  paiseToRupeesString,
  parsePricePaise,
};
