const { parseDateOnly, parsePositiveInteger } = require("./washing");

const INPUT_CATEGORIES = ["raw_material", "washed_raw_material"];

const isAllowedInputCategory = (category) => INPUT_CATEGORIES.includes(category);

const isFinishedGoodsCategory = (category) => category === "finished_goods";

const hasSufficientStock = (available, quantityUsed) =>
  Number.isInteger(available) && Number.isInteger(quantityUsed) && available >= quantityUsed;

const canReverseFinishedOutput = (available, quantityProduced) =>
  hasSufficientStock(available, quantityProduced);

const canReverseManufacturing = (status) => status === "completed";

const parseNonNegativeInteger = (value, field = "Wastage") => {
  if (!/^\d+$/.test(String(value))) {
    return { valid: false, message: `${field} must be a whole number of zero or more.` };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { valid: false, message: `${field} must be a whole number of zero or more.` };
  }

  return { valid: true, value: parsed };
};

const cleanOptionalText = (value, field, maximum) => {
  if (value === undefined || value === null) return { valid: true, value: "" };
  if (typeof value !== "string" || value.trim().length > maximum) {
    return { valid: false, message: `${field} must be text with ${maximum} characters or fewer.` };
  }

  return { valid: true, value: value.trim() };
};

const validateManufacturingPayload = (body = {}) => {
  if (!Array.isArray(body.inputs) || body.inputs.length === 0) {
    return { valid: false, message: "At least one Raw or Washed input is required." };
  }

  if (!body.output || typeof body.output !== "object") {
    return { valid: false, message: "One Finished Goods output is required." };
  }

  const manufacturingDate = parseDateOnly(body.manufacturingDate, "Manufacturing date");
  const notes = cleanOptionalText(body.notes, "Notes", 500);
  const outputQuantity = parsePositiveInteger(body.output.quantityProduced, "Quantity produced");

  if (!manufacturingDate.valid || !notes.valid || !outputQuantity.valid) {
    return {
      valid: false,
      message: manufacturingDate.message || notes.message || outputQuantity.message,
    };
  }

  const inputs = [];
  const selectedItemIds = new Set();

  for (let index = 0; index < body.inputs.length; index += 1) {
    const input = body.inputs[index] || {};
    const quantityUsed = parsePositiveInteger(
      input.quantityUsed,
      `Input ${index + 1} quantity used`
    );
    const wastage = parseNonNegativeInteger(input.wastage ?? 0, `Input ${index + 1} wastage`);

    if (!input.stockItem || !quantityUsed.valid || !wastage.valid) {
      return {
        valid: false,
        message: !input.stockItem
          ? `Input ${index + 1} stock item is required.`
          : quantityUsed.message || wastage.message,
      };
    }

    if (wastage.value > quantityUsed.value) {
      return { valid: false, message: `Input ${index + 1} wastage cannot exceed quantity used.` };
    }

    const id = String(input.stockItem);
    if (selectedItemIds.has(id)) {
      return { valid: false, message: "Select each input stock item only once." };
    }

    selectedItemIds.add(id);
    inputs.push({ stockItem: id, quantityUsed: quantityUsed.value, wastage: wastage.value });
  }

  if (!body.output.finishedStockItem) {
    return { valid: false, message: "Finished Goods output is required." };
  }

  return {
    valid: true,
    value: {
      manufacturingDate: manufacturingDate.value,
      notes: notes.value,
      inputs,
      output: {
        finishedStockItem: String(body.output.finishedStockItem),
        quantityProduced: outputQuantity.value,
      },
    },
  };
};

module.exports = {
  INPUT_CATEGORIES,
  canReverseManufacturing,
  canReverseFinishedOutput,
  cleanOptionalText,
  hasSufficientStock,
  isAllowedInputCategory,
  isFinishedGoodsCategory,
  parseNonNegativeInteger,
  validateManufacturingPayload,
};
