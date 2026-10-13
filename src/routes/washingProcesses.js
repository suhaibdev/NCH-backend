const express = require("express");
const mongoose = require("mongoose");
const StockItem = require("../models/StockItem");
const StockIdentityLock = require("../models/StockIdentityLock");
const StockMovement = require("../models/StockMovement");
const StockType = require("../models/StockType");
const Supplier = require("../models/Supplier");
const Washer = require("../models/Washer");
const WashingProcess = require("../models/WashingProcess");
const { parsePositiveInteger, parseMoneyToPaise, parseDateOnly, hasCompleteSize, calculateChargePaise, makeIdentityQuery, makeIdentityKey } = require("../utils/washing");

const router = express.Router();
const parsePage = (value, fallback, maximum) => {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
};
const cleanNotes = (value) => {
  if (value === undefined || value === null) return { valid: true, value: "" };
  if (typeof value !== "string" || value.trim().length > 500) return { valid: false, message: "Notes must be text with 500 characters or fewer." };
  return { valid: true, value: value.trim() };
};
const objectId = (value, message) => mongoose.Types.ObjectId.isValid(value) ? null : { valid: false, message };
const formatProcess = (process) => ({
  ...process,
  ratePerPiece: (process.ratePerPiecePaise / 100).toFixed(2),
  estimatedCharge: (process.estimatedChargePaise / 100).toFixed(2),
  earnedAmount: process.earnedAmountPaise === null ? null : (process.earnedAmountPaise / 100).toFixed(2),
});

router.get("/source-stock", async (req, res) => {
  try {
    const page = parsePage(req.query.page, 1, 1000000);
    const limit = parsePage(req.query.limit, 25, 100);
    if (!page || !limit) return res.status(400).json({ message: "Page and limit must be positive integers; limit cannot exceed 100." });
    const search = String(req.query.search || "").trim().slice(0, 100);
    const eligibleTypes = await StockType.find({ category: "raw_material", requiresSupplier: true, requiresSize: true }).select("_id").lean();
    const typeIds = eligibleTypes.map((type) => type._id);
    if (!typeIds.length) return res.json({ items: [], pagination: { page, limit, totalItems: 0, totalPages: 0 } });
    const query = { category: "raw_material", stockType: { $in: typeIds }, supplier: { $ne: null }, unit: "pcs", currentStock: { $gt: 0 }, "size.lengthValue": { $gt: 0 }, "size.widthValue": { $gt: 0 } };
    if (search) query.productName = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    const [items, totalItems] = await Promise.all([
      StockItem.find(query).select("productName stockType supplier size unit currentStock").populate("stockType", "name category requiresSupplier requiresSize").populate("supplier", "name").sort({ productName: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      StockItem.countDocuments(query),
    ]);
    return res.json({ items, pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
  } catch (err) {
    console.error("GET WASHING SOURCE STOCK ERROR:", err);
    return res.status(500).json({ message: "Unable to load eligible raw stock." });
  }
});

router.get("/", async (req, res) => {
  try {
    const page = parsePage(req.query.page, 1, 1000000);
    const limit = parsePage(req.query.limit, 20, 100);
    const status = String(req.query.status || "in_process");
    if (!page || !limit || !["in_process", "completed", "all"].includes(status)) return res.status(400).json({ message: "Use valid status, page and limit values." });
    const query = status === "all" ? {} : { status };
    const [items, totalItems] = await Promise.all([
      WashingProcess.find(query).select("sourceStockItem sourceStockType sourceStockTypeName supplier supplierName size unit quantity washer washerName ratePerPiecePaise estimatedChargePaise earnedAmountPaise status sentDate completedDate destinationStockItem destinationStockType destinationStockTypeName notes createdAt").sort({ sentDate: -1, createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      WashingProcess.countDocuments(query),
    ]);
    return res.json({ items: items.map(formatProcess), pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
  } catch (err) {
    console.error("GET WASHING PROCESSES ERROR:", err);
    return res.status(500).json({ message: "Unable to load washing processes." });
  }
});

router.post("/", async (req, res) => {
  const body = req.body || {};
  const sourceError = objectId(body.sourceStockItem, "Invalid source stock item ID.");
  const washerError = objectId(body.washer, "Invalid washer ID.");
  const destinationError = objectId(body.destinationStockType, "Invalid Washed Output Type ID.");
  const quantity = parsePositiveInteger(body.quantity);
  const rate = parseMoneyToPaise(body.ratePerPiece);
  const sentDate = parseDateOnly(body.sentDate, "Sent date");
  const notes = cleanNotes(body.notes);
  if (sourceError || washerError || destinationError || !quantity.valid || !rate.valid || !sentDate.valid || !notes.valid) return res.status(400).json({ message: sourceError?.message || washerError?.message || destinationError?.message || quantity.message || rate.message || sentDate.message || notes.message });
  const estimatedChargePaise = calculateChargePaise(quantity.value, rate.value);
  if (estimatedChargePaise === null) return res.status(400).json({ message: "Washer charge is too large." });

  const session = await mongoose.startSession();
  let response;
  try {
    await session.withTransaction(async () => {
      const source = await StockItem.findById(body.sourceStockItem).session(session);
      if (!source) throw Object.assign(new Error("Source stock item not found."), { statusCode: 404 });
      if (source.category !== "raw_material" || source.unit !== "pcs" || !source.stockType || !source.supplier || !hasCompleteSize(source.size)) throw Object.assign(new Error("Only supplier-and-size-tracked Raw Material in PCS can be sent to washing."), { statusCode: 400 });
      const [sourceType, supplier, washer, destinationType] = await Promise.all([
        StockType.findOne({ _id: source.stockType, category: "raw_material", requiresSupplier: true, requiresSize: true }).session(session).lean(),
        Supplier.findById(source.supplier).select("name").session(session).lean(),
        Washer.findOne({ _id: body.washer, isActive: true }).session(session).lean(),
        StockType.findOne({ _id: body.destinationStockType, category: "washed_raw_material", requiresSupplier: true, requiresSize: true }).session(session).lean(),
      ]);
      if (!sourceType) throw Object.assign(new Error("Source stock must use a configured Raw Material Stock Type requiring supplier and size."), { statusCode: 400 });
      if (!supplier) throw Object.assign(new Error("Source supplier was not found."), { statusCode: 400 });
      if (!washer) throw Object.assign(new Error("Washer was not found or is inactive."), { statusCode: 400 });
      if (!destinationType) throw Object.assign(new Error("Select an eligible Washed Output Type."), { statusCode: 400 });
      const updatedSource = await StockItem.findOneAndUpdate({ _id: source._id, currentStock: { $gte: quantity.value } }, { $inc: { currentStock: -quantity.value } }, { new: true, runValidators: true, session });
      if (!updatedSource) throw Object.assign(new Error(`Insufficient source stock. Only ${source.currentStock} PCS is available.`), { statusCode: 400 });
      const created = await WashingProcess.create([{
        sourceStockItem: source._id, sourceStockType: sourceType._id, sourceStockTypeName: sourceType.name,
        supplier: supplier._id, supplierName: supplier.name, size: source.size, unit: "pcs", quantity: quantity.value,
        washer: washer._id, washerName: washer.name, ratePerPiecePaise: rate.value, estimatedChargePaise,
        destinationStockType: destinationType._id, destinationStockTypeName: destinationType.name,
        sentDate: sentDate.value, notes: notes.value, createdBy: req.user?.id || "Admin",
      }], { session });
      const process = created[0];
      await StockMovement.create([{
        item: source._id, productName: source.productName, category: source.category, stockType: sourceType._id, stockTypeName: sourceType.name,
        supplier: supplier._id, supplierName: supplier.name, size: source.size, unit: "pcs", direction: "out", movementType: "washing_sent",
        quantity: quantity.value, balanceBefore: source.currentStock, balanceAfter: updatedSource.currentStock,
        reason: "Sent to washing", notes: notes.value, referenceType: "washing_process", referenceId: process._id,
        movementDate: sentDate.value, createdBy: req.user?.id || "Admin",
      }], { session });
      response = { process: formatProcess(process.toObject()), sourceBalance: updatedSource.currentStock };
    });
    return res.status(201).json({ message: "Goods sent to washing successfully.", ...response });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    console.error("CREATE WASHING PROCESS ERROR:", err);
    return res.status(500).json({ message: "Unable to send goods to washing." });
  } finally { await session.endSession(); }
});

router.post("/:id/complete", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid washing process ID." });
  const body = req.body || {};
  const completedDate = parseDateOnly(body.completedDate, "Completed date");
  if (!completedDate.valid) return res.status(400).json({ message: completedDate.message });
  const session = await mongoose.startSession();
  let response;
  try {
    await session.withTransaction(async () => {
      const process = await WashingProcess.findById(req.params.id).session(session);
      if (!process) throw Object.assign(new Error("Washing process not found."), { statusCode: 404 });
      if (process.status !== "in_process") throw Object.assign(new Error("This washing process has already been completed."), { statusCode: 409 });
      if (completedDate.value < process.sentDate) throw Object.assign(new Error("Completed date cannot be before the sent date."), { statusCode: 400 });
      const destinationType = await StockType.findOne({ _id: process.destinationStockType, category: "washed_raw_material", requiresSupplier: true, requiresSize: true }).session(session).lean();
      if (!destinationType) throw Object.assign(new Error("The saved Washed Output Type is no longer eligible. Restore its supplier/size tracking before completion."), { statusCode: 400 });
      const identity = { category: "washed_raw_material", stockType: destinationType._id, supplier: process.supplier, size: process.size, unit: process.unit };
      const identityQuery = makeIdentityQuery(identity);
      let matches = await StockItem.find(identityQuery).sort({ createdAt: 1, _id: 1 }).limit(2).session(session);
      if (matches.length > 1) throw Object.assign(new Error("Multiple matching washed stock items exist. Resolve duplicate stock records before completing this process."), { statusCode: 409 });
      let destination = matches[0];
      let balanceBefore = 0;
      if (destination) {
        balanceBefore = destination.currentStock;
        destination = await StockItem.findOneAndUpdate({ _id: destination._id }, { $inc: { currentStock: process.quantity } }, { new: true, runValidators: true, session });
      } else {
        const key = makeIdentityKey(identity);
        const lock = await StockIdentityLock.findOneAndUpdate({ identityKey: key }, { $setOnInsert: { identityKey: key } }, { new: true, upsert: true, session, setDefaultsOnInsert: true });
        matches = await StockItem.find(identityQuery).sort({ createdAt: 1, _id: 1 }).limit(2).session(session);
        if (matches.length > 1) throw Object.assign(new Error("Multiple matching washed stock items exist. Resolve duplicate stock records before completing this process."), { statusCode: 409 });
        if (matches[0]) {
          balanceBefore = matches[0].currentStock;
          destination = await StockItem.findOneAndUpdate({ _id: matches[0]._id }, { $inc: { currentStock: process.quantity } }, { new: true, runValidators: true, session });
        } else {
          destination = (await StockItem.create([{ productName: destinationType.name, category: "washed_raw_material", stockType: destinationType._id, supplier: process.supplier, size: process.size, unit: process.unit, currentStock: process.quantity, minimumStock: 0, notes: "" }], { session }))[0];
          await StockIdentityLock.updateOne({ _id: lock._id }, { $set: { stockItem: destination._id } }, { session });
        }
      }
      process.status = "completed";
      process.completedDate = completedDate.value;
      process.destinationStockItem = destination._id;
      process.earnedAmountPaise = process.estimatedChargePaise;
      process.completedBy = req.user?.id || "Admin";
      await process.save({ session });
      await StockMovement.create([{
        item: destination._id, productName: destination.productName, category: destination.category, stockType: destinationType._id, stockTypeName: destinationType.name,
        supplier: process.supplier, supplierName: process.supplierName, size: process.size, unit: process.unit, direction: "in", movementType: "washing_completed",
        quantity: process.quantity, balanceBefore, balanceAfter: destination.currentStock, reason: "Washing completed", notes: process.notes,
        referenceType: "washing_process", referenceId: process._id, movementDate: completedDate.value, createdBy: req.user?.id || "Admin",
      }], { session });
      response = { process: formatProcess(process.toObject()), destinationBalance: destination.currentStock };
    });
    return res.json({ message: "Washing completed and washed stock updated successfully.", ...response });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    if (err?.code === 11000) return res.status(409).json({ message: "A simultaneous stock update occurred. Please retry completion." });
    console.error("COMPLETE WASHING PROCESS ERROR:", err);
    return res.status(500).json({ message: "Unable to complete washing process." });
  } finally { await session.endSession(); }
});

router.validation = Object.freeze({ parsePositiveInteger, parseMoneyToPaise, parseDateOnly, hasCompleteSize, calculateChargePaise, makeIdentityKey });
module.exports = router;
