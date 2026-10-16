const express = require("express");
const mongoose = require("mongoose");

const ManufacturingCounter = require("../models/ManufacturingCounter");
const ManufacturingEntry = require("../models/ManufacturingEntry");
const StockItem = require("../models/StockItem");
const StockMovement = require("../models/StockMovement");
const StockType = require("../models/StockType");
const Supplier = require("../models/Supplier");
const { buildManufacturingHistoryQuery } = require("../utils/manufacturingHistory");
const {
  INPUT_CATEGORIES,
  canReverseManufacturing,
  canReverseFinishedOutput,
  cleanOptionalText,
  hasValidLabelUsage,
  isAllowedInputCategory,
  isFinishedGoodsCategory,
  validateManufacturingPayload,
} = require("../utils/manufacturing");

const router = express.Router();

const parsePage = (value, fallback, maximum) => {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
};

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const requestError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

const requireObjectId = (value, field) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw requestError(400, `${field} is invalid.`);
  }
};

const getNumber = async (manufacturingDate, session) => {
  const year = manufacturingDate.getUTCFullYear();
  const counter = await ManufacturingCounter.findOneAndUpdate(
    { year },
    { $inc: { sequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );

  return `MF-${year}-${String(counter.sequence).padStart(4, "0")}`;
};

const getConfiguredLabelStockType = (session) => {
  const query = StockType.findOne({
    category: "raw_material",
    normalizedName: "label",
  }).select("name normalizedName category");

  if (session) query.session(session);
  return query.lean();
};

const getSnapshots = async (item, session) => {
  const [stockType, supplier] = await Promise.all([
    item.stockType
      ? StockType.findById(item.stockType).select("name").session(session).lean()
      : null,
    item.supplier ? Supplier.findById(item.supplier).select("name").session(session).lean() : null,
  ]);

  return { stockType, supplier };
};

const inputSnapshot = (item, snapshots, input) => ({
  item: item._id,
  productName: item.productName,
  category: item.category,
  stockType: item.stockType || null,
  stockTypeName: snapshots.stockType?.name || "",
  supplier: item.supplier || null,
  supplierName: snapshots.supplier?.name || "",
  size: item.size || null,
  unit: item.unit,
  quantityUsed: input.quantityUsed,
  wastage: input.wastage,
});

const createInputMovement = (
  item,
  snapshot,
  balanceAfter,
  entry,
  manufacturingDate,
  createdBy
) => ({
  item: item._id,
  productName: snapshot.productName,
  category: snapshot.category,
  stockType: snapshot.stockType,
  stockTypeName: snapshot.stockTypeName,
  supplier: snapshot.supplier,
  supplierName: snapshot.supplierName,
  size: snapshot.size,
  unit: snapshot.unit,
  direction: "out",
  movementType: "manufacturing_use",
  quantity: snapshot.quantityUsed,
  balanceBefore: item.currentStock,
  balanceAfter,
  reason: `Manufacturing ${entry.manufacturingNumber}`,
  notes: entry.notes,
  referenceType: "manufacturing",
  referenceId: entry._id,
  movementDate: manufacturingDate,
  createdBy,
});

router.get("/stock-items", async (req, res) => {
  try {
    const kind = String(req.query.kind || "");
    const page = parsePage(req.query.page, 1, 1000000);
    const limit = parsePage(req.query.limit, 25, 100);
    const search = String(req.query.search || "")
      .trim()
      .slice(0, 100);

    if (!page || !limit || !["input", "output", "washed", "label"].includes(kind)) {
      return res.status(400).json({ message: "Use a valid kind, page and limit." });
    }

    const labelStockType = kind === "label" ? await getConfiguredLabelStockType() : null;
    let query;

    if (kind === "output") {
      query = { category: "finished_goods" };
    } else if (kind === "washed") {
      query = { category: "washed_raw_material", currentStock: { $gt: 0 } };
    } else if (kind === "label") {
      query = labelStockType
        ? { category: "raw_material", stockType: labelStockType._id }
        : { _id: null };
    } else {
      query = { category: { $in: INPUT_CATEGORIES }, currentStock: { $gt: 0 } };
    }

    if (search) {
      query.productName = { $regex: escapeRegex(search), $options: "i" };
    }

    const [items, totalItems] = await Promise.all([
      StockItem.find(query)
        .select("productName category stockType supplier size unit currentStock")
        .populate("stockType", "name")
        .populate("supplier", "name")
        .sort({ productName: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      StockItem.countDocuments(query),
    ]);

    return res.json({
      items,
      pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
      labelStockType: labelStockType
        ? { _id: labelStockType._id, name: labelStockType.name }
        : null,
    });
  } catch (err) {
    console.error("GET MANUFACTURING STOCK ITEMS ERROR:", err);
    return res.status(500).json({ message: "Unable to load manufacturing stock items." });
  }
});

router.get("/", async (req, res) => {
  try {
    const historyQuery = buildManufacturingHistoryQuery(req.query);
    if (!historyQuery.valid) return res.status(400).json({ message: historyQuery.message });

    const { page, limit, filters } = historyQuery.value;

    const [items, totalItems] = await Promise.all([
      ManufacturingEntry.find(filters)
        .select(
          "batchNumber manufacturingNumber manufacturingDate finishedProductName finishedUnit quantityManufactured output materials notes status reversed reversedAt reverseReason reversedBy createdBy createdAt"
        )
        .sort({ manufacturingDate: -1, createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ManufacturingEntry.countDocuments(filters),
    ]);

    return res.json({
      items,
      pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
    });
  } catch (err) {
    console.error("GET MANUFACTURING HISTORY ERROR:", err);
    return res.status(500).json({ message: "Unable to load manufacturing history." });
  }
});

router.get("/history-filter-options", async (_req, res) => {
  try {
    const sizes = await ManufacturingEntry.aggregate([
      { $unwind: "$materials" },
      {
        $match: {
          "materials.size.lengthValue": { $ne: null },
          "materials.size.lengthUnit": { $ne: null },
          "materials.size.widthValue": { $ne: null },
          "materials.size.widthUnit": { $ne: null },
        },
      },
      {
        $group: {
          _id: {
            lengthValue: "$materials.size.lengthValue",
            lengthUnit: "$materials.size.lengthUnit",
            widthValue: "$materials.size.widthValue",
            widthUnit: "$materials.size.widthUnit",
          },
        },
      },
      { $sort: { "_id.lengthValue": 1, "_id.widthValue": 1 } },
      { $limit: 100 },
    ]);

    return res.json({
      sizes: sizes.map(({ _id: size }) => ({
        key: `${size.lengthValue}|${size.lengthUnit}|${size.widthValue}|${size.widthUnit}`,
        label: `${size.lengthValue} ${size.lengthUnit} × ${size.widthValue} ${size.widthUnit}`,
      })),
    });
  } catch (err) {
    console.error("GET MANUFACTURING HISTORY FILTER OPTIONS ERROR:", err);
    return res.status(500).json({ message: "Unable to load manufacturing history filters." });
  }
});

router.get("/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid manufacturing entry ID." });
  }

  try {
    const entry = await ManufacturingEntry.findById(req.params.id).lean();
    if (!entry) return res.status(404).json({ message: "Manufacturing entry not found." });
    return res.json({ entry });
  } catch (err) {
    console.error("GET MANUFACTURING DETAIL ERROR:", err);
    return res.status(500).json({ message: "Unable to load manufacturing entry." });
  }
});

router.post("/", async (req, res) => {
  const validation = validateManufacturingPayload(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  const payload = validation.value;
  try {
    payload.inputs.forEach((input, index) =>
      requireObjectId(input.stockItem, `Input ${index + 1} stock item`)
    );
    requireObjectId(payload.output.finishedStockItem, "Finished Goods output");
  } catch (err) {
    return res.status(err.statusCode || 400).json({ message: err.message });
  }

  const session = await mongoose.startSession();
  let response;

  try {
    await session.withTransaction(async () => {
      const createdBy = req.user?.id || "Admin";
      const finishedItem = await StockItem.findById(payload.output.finishedStockItem).session(
        session
      );
      if (!finishedItem) throw requestError(404, "Finished Goods output item was not found.");
      if (!isFinishedGoodsCategory(finishedItem.category)) {
        throw requestError(400, "Manufacturing output must be a Finished Goods item.");
      }
      if (finishedItem.supplier) {
        throw requestError(400, "Finished Goods output cannot have supplier ownership.");
      }

      const duplicateBatch = await ManufacturingEntry.findOne({
        normalizedBatchNumber: payload.normalizedBatchNumber,
      })
        .select("_id")
        .session(session)
        .lean();
      if (duplicateBatch) {
        throw requestError(409, `Batch No. ${payload.batchNumber} already exists.`);
      }

      const labelStockType = await getConfiguredLabelStockType(session);
      if (!labelStockType) {
        throw requestError(400, "No Label Stock Type is configured.");
      }

      const inputRecords = [];
      let labelRecord = null;
      let hasWashedInput = false;

      for (const input of payload.inputs) {
        const item = await StockItem.findById(input.stockItem).session(session);
        if (!item) throw requestError(404, "An input stock item was not found.");
        if (!isAllowedInputCategory(item.category)) {
          throw requestError(
            400,
            "Manufacturing inputs must be Raw Material or Washed Raw Material."
          );
        }

        const isLabel = String(item.stockType || "") === String(labelStockType._id);
        if (isLabel) {
          if (labelRecord) {
            throw requestError(400, "Select only one Label input.");
          }
          if (item.category !== "raw_material" || item.unit !== "pcs") {
            throw requestError(400, "The configured Label item must be a Raw Material in PCS.");
          }
          labelRecord = { item, input };
        }

        if (item.category === "washed_raw_material") {
          hasWashedInput = true;
        }

        const snapshots = await getSnapshots(item, session);
        inputRecords.push({
          item,
          input,
          snapshot: inputSnapshot(item, snapshots, input),
          isLabel,
        });
      }

      if (!hasWashedInput) {
        throw requestError(400, "At least one Washed Raw Material input is required.");
      }
      if (!labelRecord) {
        throw requestError(400, "A Label input is required.");
      }
      if (!hasValidLabelUsage(labelRecord.input, payload.output.quantityProduced)) {
        throw requestError(
          400,
          "Label Quantity Used must exactly match Finished Quantity, with zero wastage."
        );
      }
      if (labelRecord.item.currentStock < payload.output.quantityProduced) {
        throw requestError(
          400,
          `Insufficient Label stock. Required ${payload.output.quantityProduced} PCS, available ${labelRecord.item.currentStock} PCS.`
        );
      }

      for (const record of inputRecords) {
        const updatedItem = await StockItem.findOneAndUpdate(
          {
            _id: record.item._id,
            category: { $in: INPUT_CATEGORIES },
            currentStock: { $gte: record.input.quantityUsed },
          },
          { $inc: { currentStock: -record.input.quantityUsed } },
          { new: true, runValidators: true, session }
        );

        if (!updatedItem) {
          if (record.isLabel) {
            throw requestError(
              400,
              `Insufficient Label stock. Required ${record.input.quantityUsed} PCS, available ${record.item.currentStock} PCS.`
            );
          }
          throw requestError(
            400,
            `Insufficient stock for ${record.item.productName}. ${record.item.currentStock} ${record.item.unit} is available.`
          );
        }

        record.updatedItem = updatedItem;
      }

      const finishedType = finishedItem.stockType
        ? await StockType.findById(finishedItem.stockType).select("name").session(session).lean()
        : null;
      const updatedFinished = await StockItem.findOneAndUpdate(
        { _id: finishedItem._id, category: "finished_goods" },
        { $inc: { currentStock: payload.output.quantityProduced } },
        { new: true, runValidators: true, session }
      );

      if (!updatedFinished) throw requestError(409, "Finished Goods output changed. Please retry.");

      const output = {
        finishedStockItem: finishedItem._id,
        finishedStockItemName: finishedItem.productName,
        stockType: finishedItem.stockType || null,
        stockTypeName: finishedType?.name || "",
        unit: finishedItem.unit,
        quantityProduced: payload.output.quantityProduced,
      };
      const manufacturingNumber = await getNumber(payload.manufacturingDate, session);
      const entry = (
        await ManufacturingEntry.create(
          [
            {
              manufacturingNumber,
              batchNumber: payload.batchNumber,
              normalizedBatchNumber: payload.normalizedBatchNumber,
              finishedItem: finishedItem._id,
              finishedProductName: finishedItem.productName,
              finishedUnit: finishedItem.unit,
              quantityManufactured: payload.output.quantityProduced,
              output,
              materials: inputRecords.map((record) => record.snapshot),
              manufacturingDate: payload.manufacturingDate,
              notes: payload.notes,
              createdBy,
              status: "completed",
            },
          ],
          { session }
        )
      )[0];

      const movements = inputRecords.map((record) =>
        createInputMovement(
          record.item,
          record.snapshot,
          record.updatedItem.currentStock,
          entry,
          payload.manufacturingDate,
          createdBy
        )
      );
      movements.push({
        item: finishedItem._id,
        productName: finishedItem.productName,
        category: "finished_goods",
        stockType: finishedItem.stockType || null,
        stockTypeName: finishedType?.name || "",
        supplier: null,
        supplierName: "",
        size: null,
        unit: finishedItem.unit,
        direction: "in",
        movementType: "manufacturing_output",
        quantity: payload.output.quantityProduced,
        balanceBefore: finishedItem.currentStock,
        balanceAfter: updatedFinished.currentStock,
        reason: `Manufacturing ${entry.manufacturingNumber}`,
        notes: payload.notes,
        referenceType: "manufacturing",
        referenceId: entry._id,
        movementDate: payload.manufacturingDate,
        createdBy,
      });
      await StockMovement.create(movements, { session });

      response = { entry: entry.toObject() };
    });

    return res.status(201).json({ message: "Manufacturing completed successfully.", ...response });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    if (err?.code === 11000)
      return res
        .status(409)
        .json({ message: "A concurrent manufacturing update occurred. Please retry." });
    console.error("CREATE MANUFACTURING ERROR:", err);
    return res.status(500).json({ message: "Unable to complete manufacturing." });
  } finally {
    await session.endSession();
  }
});

router.post("/:id/reverse", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid manufacturing entry ID." });
  }

  const reason = cleanOptionalText(req.body?.reason, "Reversal reason", 500);
  if (!reason.valid || !reason.value) {
    return res.status(400).json({ message: reason.message || "Reversal reason is required." });
  }

  const session = await mongoose.startSession();
  let response;

  try {
    await session.withTransaction(async () => {
      const createdBy = req.user?.id || "Admin";
      const entry = await ManufacturingEntry.findById(req.params.id).session(session);
      if (!entry) throw requestError(404, "Manufacturing entry not found.");
      if (!canReverseManufacturing(entry.status) || entry.reversed) {
        throw requestError(409, "This manufacturing entry has already been reversed.");
      }

      const finished = await StockItem.findById(entry.output.finishedStockItem).session(session);
      if (!finished) throw requestError(409, "Finished Goods output item no longer exists.");
      const reducedFinished = await StockItem.findOneAndUpdate(
        {
          _id: finished._id,
          category: "finished_goods",
          currentStock: { $gte: entry.output.quantityProduced },
        },
        { $inc: { currentStock: -entry.output.quantityProduced } },
        { new: true, runValidators: true, session }
      );
      if (
        !canReverseFinishedOutput(finished.currentStock, entry.output.quantityProduced) ||
        !reducedFinished
      ) {
        throw requestError(
          400,
          `Cannot reverse ${entry.manufacturingNumber}: only ${finished.currentStock} ${finished.unit} finished stock is available.`
        );
      }

      const restoredInputs = [];
      for (const input of entry.materials) {
        const current = await StockItem.findById(input.item).session(session);
        if (!current || current.category !== input.category) {
          throw requestError(
            409,
            `Input stock for ${input.productName} is no longer available for reversal.`
          );
        }
        const restored = await StockItem.findOneAndUpdate(
          { _id: current._id, category: input.category },
          { $inc: { currentStock: input.quantityUsed } },
          { new: true, runValidators: true, session }
        );
        if (!restored) throw requestError(409, `Unable to restore ${input.productName}.`);
        restoredInputs.push({ current, restored, input });
      }

      entry.status = "reversed";
      entry.reversed = true;
      entry.reversedAt = new Date();
      entry.reverseReason = reason.value;
      entry.reversedBy = createdBy;
      await entry.save({ session });

      const movements = restoredInputs.map(({ current, restored, input }) => ({
        item: current._id,
        productName: input.productName,
        category: input.category,
        stockType: input.stockType || null,
        stockTypeName: input.stockTypeName || "",
        supplier: input.supplier || null,
        supplierName: input.supplierName || "",
        size: input.size || null,
        unit: input.unit,
        direction: "in",
        movementType: "manufacturing_reverse_in",
        quantity: input.quantityUsed,
        balanceBefore: current.currentStock,
        balanceAfter: restored.currentStock,
        reason: `Reversal of ${entry.manufacturingNumber}`,
        notes: reason.value,
        referenceType: "manufacturing",
        referenceId: entry._id,
        movementDate: entry.reversedAt,
        createdBy,
      }));
      movements.push({
        item: finished._id,
        productName: entry.output.finishedStockItemName,
        category: "finished_goods",
        stockType: entry.output.stockType || null,
        stockTypeName: entry.output.stockTypeName || "",
        supplier: null,
        supplierName: "",
        size: null,
        unit: entry.output.unit,
        direction: "out",
        movementType: "manufacturing_reverse_out",
        quantity: entry.output.quantityProduced,
        balanceBefore: finished.currentStock,
        balanceAfter: reducedFinished.currentStock,
        reason: `Reversal of ${entry.manufacturingNumber}`,
        notes: reason.value,
        referenceType: "manufacturing",
        referenceId: entry._id,
        movementDate: entry.reversedAt,
        createdBy,
      });
      await StockMovement.create(movements, { session });

      response = { entry: entry.toObject() };
    });

    return res.json({ message: "Manufacturing reversed successfully.", ...response });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    console.error("REVERSE MANUFACTURING ERROR:", err);
    return res.status(500).json({ message: "Unable to reverse manufacturing." });
  } finally {
    await session.endSession();
  }
});

router.validation = Object.freeze({ validateManufacturingPayload });

module.exports = router;
