const mongoose = require("mongoose");

const parsePage = (value, fallback, maximum) => {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
};

const parseDateOnly = (value, field) => {
  if (!value) return { valid: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return { valid: false, message: `${field} must use YYYY-MM-DD.` };
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return { valid: false, message: `${field} is invalid.` };
  }

  return { valid: true, value: date };
};

const monthBounds = (value) => {
  if (!value) return { valid: true, value: null };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value))) {
    return { valid: false, message: "Month must use YYYY-MM." };
  }

  const [year, month] = value.split("-").map(Number);
  return {
    valid: true,
    value: {
      start: new Date(Date.UTC(year, month - 1, 1)),
      end: new Date(Date.UTC(year, month, 1)),
    },
  };
};

const parseSizeKey = (value) => {
  if (!value) return { valid: true, value: null };
  const [lengthValue, lengthUnit, widthValue, widthUnit, ...unexpected] = String(value).split("|");
  const units = ["m", "cm", "inch", "ft"];
  const parsedLength = Number(lengthValue);
  const parsedWidth = Number(widthValue);

  if (
    unexpected.length ||
    !Number.isFinite(parsedLength) ||
    !Number.isFinite(parsedWidth) ||
    parsedLength <= 0 ||
    parsedWidth <= 0 ||
    !units.includes(lengthUnit) ||
    !units.includes(widthUnit)
  ) {
    return { valid: false, message: "Size filter is invalid." };
  }

  return {
    valid: true,
    value: { lengthValue: parsedLength, lengthUnit, widthValue: parsedWidth, widthUnit },
  };
};

const buildManufacturingHistoryQuery = (query = {}) => {
  const page = parsePage(query.page, 1, 1000000);
  const limit = parsePage(query.limit, 20, 100);
  const fromDate = parseDateOnly(query.fromDate, "From Date");
  const toDate = parseDateOnly(query.toDate, "To Date");
  const month = monthBounds(query.month);
  const size = parseSizeKey(query.size);
  const batchNumber = String(query.batchNumber || "").trim().slice(0, 100);
  const finishedItem = String(query.finishedItem || "").trim();

  if (!page || !limit) {
    return { valid: false, message: "Page and limit must be positive integers." };
  }
  if (!fromDate.valid || !toDate.valid || !month.valid || !size.valid) {
    return {
      valid: false,
      message: fromDate.message || toDate.message || month.message || size.message,
    };
  }
  if (finishedItem && !mongoose.Types.ObjectId.isValid(finishedItem)) {
    return { valid: false, message: "Finished Product filter is invalid." };
  }

  let start = fromDate.value;
  let end = toDate.value ? new Date(toDate.value.getTime() + 24 * 60 * 60 * 1000) : null;
  if (month.value) {
    start = !start || month.value.start > start ? month.value.start : start;
    end = !end || month.value.end < end ? month.value.end : end;
  }
  if (start && end && start >= end) {
    return { valid: false, message: "From Date cannot be after To Date." };
  }

  const filters = {};
  if (start || end) {
    filters.manufacturingDate = {};
    if (start) filters.manufacturingDate.$gte = start;
    if (end) filters.manufacturingDate.$lt = end;
  }
  if (finishedItem) filters.finishedItem = new mongoose.Types.ObjectId(finishedItem);
  if (batchNumber) filters.normalizedBatchNumber = { $regex: batchNumber.toLowerCase() };
  if (size.value) {
    filters.materials = {
      $elemMatch: {
        "size.lengthValue": size.value.lengthValue,
        "size.lengthUnit": size.value.lengthUnit,
        "size.widthValue": size.value.widthValue,
        "size.widthUnit": size.value.widthUnit,
      },
    };
  }

  return { valid: true, value: { page, limit, filters } };
};

module.exports = { buildManufacturingHistoryQuery, parseSizeKey };
