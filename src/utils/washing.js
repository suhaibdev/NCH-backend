const SIZE_UNITS = ["m", "cm", "inch", "ft"];

const parsePositiveInteger = (value, field = "Quantity") => {
  if (!/^\d+$/.test(String(value))) return { valid: false, message: `${field} must be a whole number greater than zero.` };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return { valid: false, message: `${field} must be a whole number greater than zero.` };
  return { valid: true, value: parsed };
};

const parseMoneyToPaise = (value, field = "Rate per PCS") => {
  const source = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) return { valid: false, message: `${field} is invalid.` };
  const [whole, fraction = ""] = source.split(".");
  const paise = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(paise) || paise < 0) return { valid: false, message: `${field} is invalid.` };
  return { valid: true, value: paise };
};

const parseDateOnly = (value, field = "Date") => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return { valid: false, message: `${field} is invalid.` };
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) return { valid: false, message: `${field} is invalid.` };
  return { valid: true, value: date };
};

const hasCompleteSize = (size) => Boolean(
  size && Number.isFinite(Number(size.lengthValue)) && Number(size.lengthValue) > 0 &&
  Number.isFinite(Number(size.widthValue)) && Number(size.widthValue) > 0 &&
  SIZE_UNITS.includes(size.lengthUnit) && SIZE_UNITS.includes(size.widthUnit)
);

const calculateChargePaise = (quantity, ratePerPiecePaise) => {
  const total = quantity * ratePerPiecePaise;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
};

const makeIdentityQuery = ({ category, stockType, supplier, size, unit }) => ({
  category, stockType, supplier,
  "size.lengthValue": size.lengthValue,
  "size.lengthUnit": size.lengthUnit,
  "size.widthValue": size.widthValue,
  "size.widthUnit": size.widthUnit,
  unit,
});

const makeIdentityKey = ({ category, stockType, supplier, size, unit }) => JSON.stringify([
  category, String(stockType), String(supplier), size.lengthValue, size.lengthUnit, size.widthValue, size.widthUnit, unit,
]);

module.exports = { SIZE_UNITS, parsePositiveInteger, parseMoneyToPaise, parseDateOnly, hasCompleteSize, calculateChargePaise, makeIdentityQuery, makeIdentityKey };
