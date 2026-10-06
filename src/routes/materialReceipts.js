const express = require("express");
const mongoose = require("mongoose");

const MaterialReceipt = require("../models/MaterialReceipt");
const StockIdentityLock = require("../models/StockIdentityLock");
const StockItem = require("../models/StockItem");
const StockMovement = require("../models/StockMovement");
const StockType = require("../models/StockType");
const Supplier = require("../models/Supplier");

const router = express.Router();

const SIZE_UNITS = ["m", "cm", "inch", "ft"];
const CONDITIONS = {
  not_washed: "raw_material",
  already_washed: "washed_raw_material",
};

const parsePositiveInteger = (value, field, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!/^\d+$/.test(String(value))) {
    return { valid: false, message: `${field} must be a whole number${minimum > 0 ? " greater than zero" : ""}.` };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return { valid: false, message: `${field} must be a whole number${minimum > 0 ? " greater than zero" : ""}.` };
  }

  return { valid: true, value: parsed };
};

const parseMoneyToPaise = (value) => {
  const source = typeof value === "number" ? String(value) : String(value ?? "").trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) {
    return { valid: false, message: "Price per PCS is invalid." };
  }

  const [whole, fraction = ""] = source.split(".");
  const paise = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));

  if (!Number.isSafeInteger(paise) || paise < 0) {
    return { valid: false, message: "Price per PCS is invalid." };
  }

  return { valid: true, value: paise };
};

const parseSize = (size) => {
  if (!size || typeof size !== "object") {
    return { valid: false, message: "A complete size is required." };
  }

  const lengthValue = Number(size.lengthValue);
  const widthValue = Number(size.widthValue);
  const lengthUnit = String(size.lengthUnit || "").trim();
  const widthUnit = String(size.widthUnit || "").trim();

  if (
    !Number.isFinite(lengthValue) ||
    !Number.isFinite(widthValue) ||
    lengthValue <= 0 ||
    widthValue <= 0 ||
    !SIZE_UNITS.includes(lengthUnit) ||
    !SIZE_UNITS.includes(widthUnit)
  ) {
    return {
      valid: false,
      message: "Enter positive length and width values with valid size units.",
    };
  }

  return {
    valid: true,
    value: { lengthValue, lengthUnit, widthValue, widthUnit },
  };
};

const parseReceivedDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));

  if (!match) {
    return { valid: false, message: "Received date is invalid." };
  }

  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3])
  ) {
    return { valid: false, message: "Received date is invalid." };
  }

  return { valid: true, value: date };
};

const cleanOptionalText = (value, field, maximum) => {
  if (value === undefined || value === null) {
    return { valid: true, value: "" };
  }

  if (typeof value !== "string") {
    return { valid: false, message: `${field} must be text.` };
  }

  const cleaned = value.trim();
  if (cleaned.length > maximum) {
    return { valid: false, message: `${field} must be ${maximum} characters or fewer.` };
  }

  return { valid: true, value: cleaned };
};

const makeIdentityQuery = ({ category, stockType, supplier, size, unit }) => ({
  category,
  stockType,
  supplier,
  "size.lengthValue": size.lengthValue,
  "size.lengthUnit": size.lengthUnit,
  "size.widthValue": size.widthValue,
  "size.widthUnit": size.widthUnit,
  unit,
});

const makeIdentityKey = ({ category, stockType, supplier, size, unit }) => JSON.stringify([
  category,
  String(stockType),
  String(supplier),
  size.lengthValue,
  size.lengthUnit,
  size.widthValue,
  size.widthUnit,
  unit,
]);

const formatReceipt = (receipt) => ({
  ...receipt,
  pricePerPiece: (receipt.pricePerPiecePaise / 100).toFixed(2),
  totalAmount: (receipt.totalAmountPaise / 100).toFixed(2),
});

/* =========================================================
   GET MATERIAL RECEIPTS

   GET /api/material-receipts?supplier=<id>&page=1&limit=10
========================================================= */
router.get("/", async (req, res) => {
  try {
    const supplier = String(req.query.supplier || "");
    if (!mongoose.Types.ObjectId.isValid(supplier)) {
      return res.status(400).json({ message: "A valid supplier ID is required." });
    }

    const pageResult = parsePositiveInteger(req.query.page ?? 1, "Page", { maximum: 1000000 });
    const limitResult = parsePositiveInteger(req.query.limit ?? 10, "Limit", { maximum: 100 });
    if (!pageResult.valid || !limitResult.valid) {
      return res.status(400).json({ message: "Page and limit must be positive integers; limit cannot exceed 100." });
    }

    const query = { supplier };
    const page = pageResult.value;
    const limit = limitResult.value;

    const [items, totalItems] = await Promise.all([
      MaterialReceipt.find(query)
        .select("supplier supplierName stockItem stockType stockTypeName category materialCondition size quantity unit pricePerPiecePaise totalAmountPaise receivedDate supplierBillNumber notes createdAt")
        .sort({ receivedDate: -1, createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      MaterialReceipt.countDocuments(query),
    ]);

    return res.json({
      items: items.map(formatReceipt),
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    });
  } catch (err) {
    console.error("GET MATERIAL RECEIPTS ERROR:", err);
    return res.status(500).json({ message: "Unable to load material receipts." });
  }
});

/* =========================================================
   CREATE MATERIAL RECEIPT
========================================================= */
router.post("/", async (req, res) => {
  const body = req.body || {};
  const supplierId = body.supplier;

  if (!mongoose.Types.ObjectId.isValid(supplierId)) {
    return res.status(400).json({ message: "Invalid supplier ID." });
  }

  if (!CONDITIONS[body.materialCondition]) {
    return res.status(400).json({ message: "Material condition must be Not Washed or Already Washed." });
  }

  if (!mongoose.Types.ObjectId.isValid(body.stockType)) {
    return res.status(400).json({ message: "Invalid Stock Type ID." });
  }

  const sizeResult = parseSize(body.size);
  if (!sizeResult.valid) return res.status(400).json({ message: sizeResult.message });

  const quantityResult = parsePositiveInteger(body.quantity, "Quantity");
  if (!quantityResult.valid) return res.status(400).json({ message: quantityResult.message });

  const priceResult = parseMoneyToPaise(body.pricePerPiece);
  if (!priceResult.valid) return res.status(400).json({ message: priceResult.message });

  const totalAmountPaise = quantityResult.value * priceResult.value;
  if (!Number.isSafeInteger(totalAmountPaise)) {
    return res.status(400).json({ message: "Purchase amount is too large." });
  }

  const receivedDateResult = parseReceivedDate(body.receivedDate);
  if (!receivedDateResult.valid) return res.status(400).json({ message: receivedDateResult.message });

  const billResult = cleanOptionalText(body.supplierBillNumber, "Supplier Bill / Invoice Number", 150);
  const notesResult = cleanOptionalText(body.notes, "Notes", 500);
  if (!billResult.valid || !notesResult.valid) {
    return res.status(400).json({ message: billResult.message || notesResult.message });
  }

  const category = CONDITIONS[body.materialCondition];
  const unit = "pcs";
  const session = await mongoose.startSession();
  let responseData;

  try {
    await session.withTransaction(async () => {
      const supplier = await Supplier.findById(supplierId).session(session).lean();
      if (!supplier) {
        throw Object.assign(new Error("Supplier not found."), { statusCode: 404 });
      }

      const stockType = await StockType.findOne({
        _id: body.stockType,
        category,
        requiresSupplier: true,
        requiresSize: true,
      }).session(session).lean();

      if (!stockType) {
        throw Object.assign(
          new Error(`No eligible ${category === "raw_material" ? "Raw Material" : "Washed Raw Material"} cloth Stock Type is configured.`),
          { statusCode: 400 }
        );
      }

      const identity = {
        category,
        stockType: stockType._id,
        supplier: supplier._id,
        size: sizeResult.value,
        unit,
      };
      const identityQuery = makeIdentityQuery(identity);
      let matchingItems = await StockItem.find(identityQuery)
        .sort({ createdAt: 1, _id: 1 })
        .limit(2)
        .session(session);

      if (matchingItems.length > 1) {
        throw Object.assign(new Error("Multiple matching stock items exist. Resolve the duplicate stock records before receiving more material."), { statusCode: 409 });
      }

      let stockItem = matchingItems[0];
      let balanceBefore = 0;

      if (stockItem) {
        balanceBefore = stockItem.currentStock;
        stockItem = await StockItem.findOneAndUpdate(
          { _id: stockItem._id },
          { $inc: { currentStock: quantityResult.value } },
          { new: true, runValidators: true, session }
        );
      } else {
        const lock = await StockIdentityLock.findOneAndUpdate(
          { identityKey: makeIdentityKey(identity) },
          { $setOnInsert: { identityKey: makeIdentityKey(identity) } },
          { new: true, upsert: true, session, setDefaultsOnInsert: true }
        );

        matchingItems = await StockItem.find(identityQuery)
          .sort({ createdAt: 1, _id: 1 })
          .limit(2)
          .session(session);

        if (matchingItems.length > 1) {
          throw Object.assign(new Error("Multiple matching stock items exist. Resolve the duplicate stock records before receiving more material."), { statusCode: 409 });
        }

        if (matchingItems[0]) {
          balanceBefore = matchingItems[0].currentStock;
          stockItem = await StockItem.findOneAndUpdate(
            { _id: matchingItems[0]._id },
            { $inc: { currentStock: quantityResult.value } },
            { new: true, runValidators: true, session }
          );
        } else {
          const createdItems = await StockItem.create([
            {
              productName: stockType.name,
              category,
              stockType: stockType._id,
              supplier: supplier._id,
              size: sizeResult.value,
              unit,
              currentStock: quantityResult.value,
              minimumStock: 0,
              notes: "",
            },
          ], { session });
          stockItem = createdItems[0];
          await StockIdentityLock.updateOne(
            { _id: lock._id },
            { $set: { stockItem: stockItem._id } },
            { session }
          );
        }
      }

      const createdReceipts = await MaterialReceipt.create([
        {
          supplier: supplier._id,
          supplierName: supplier.name,
          stockItem: stockItem._id,
          stockType: stockType._id,
          stockTypeName: stockType.name,
          category,
          materialCondition: body.materialCondition,
          size: sizeResult.value,
          quantity: quantityResult.value,
          unit,
          pricePerPiecePaise: priceResult.value,
          totalAmountPaise,
          receivedDate: receivedDateResult.value,
          supplierBillNumber: billResult.value,
          notes: notesResult.value,
          createdBy: req.user?.id || "Admin",
        },
      ], { session });
      const receipt = createdReceipts[0];

      await StockMovement.create([
        {
          item: stockItem._id,
          productName: stockItem.productName,
          category,
          stockType: stockType._id,
          stockTypeName: stockType.name,
          supplier: supplier._id,
          supplierName: supplier.name,
          size: sizeResult.value,
          unit,
          direction: "in",
          movementType: "material_receipt",
          quantity: quantityResult.value,
          balanceBefore,
          balanceAfter: stockItem.currentStock,
          reason: "Material receipt",
          notes: notesResult.value,
          referenceType: "material_receipt",
          referenceId: receipt._id,
          movementDate: receivedDateResult.value,
          createdBy: req.user?.id || "Admin",
        },
      ], { session });

      responseData = {
        receipt: formatReceipt(receipt.toObject()),
        stock: {
          itemId: stockItem._id,
          productName: stockItem.productName,
          previousStock: balanceBefore,
          currentStock: stockItem.currentStock,
          unit,
        },
      };
    });

    return res.status(201).json({
      message: "Material received successfully.",
      ...responseData,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ message: err.message });
    }

    if (err?.code === 11000) {
      return res.status(409).json({
        message: "A simultaneous receipt is being processed for this stock identity. Please retry.",
      });
    }

    console.error("CREATE MATERIAL RECEIPT ERROR:", err);
    return res.status(500).json({ message: "Unable to receive material." });
  } finally {
    await session.endSession();
  }
});

/* Exported only for lightweight validation checks; this is not an API route. */
router.validation = Object.freeze({
  CONDITIONS,
  parsePositiveInteger,
  parseMoneyToPaise,
  parseSize,
  parseReceivedDate,
});

module.exports = router;
