/*
 * Shared transactional steps for sales documents (Estimates, Invoices).
 *
 * Every helper that takes a session runs exactly one operation at a time on
 * it; callers must await each call before the next. All values built for a
 * transaction attempt must be created inside the withTransaction callback,
 * because the driver may retry it.
 */
const mongoose = require("mongoose");

const CustomerProductPrice = require("../models/CustomerProductPrice");
const StockItem = require("../models/StockItem");
const { sendServerError } = require("./httpErrors");

const UNIT_LABELS = { pcs: "PCS", dozen: "Dozen" };
const unitLabel = (unit) => UNIT_LABELS[unit] || unit;
const rupees = (paise) => `Rs ${(paise / 100).toFixed(2)}`;

const requestError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

const actorOf = (req) => (req.user?.id ? String(req.user.id) : "Admin");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sortByItem = (lines) =>
  [...lines].sort((a, b) =>
    String(a.item) < String(b.item) ? -1 : String(a.item) > String(b.item) ? 1 : 0
  );

const isConcurrencyError = (err) =>
  err?.code === 11000 ||
  err?.code === 112 ||
  err?.codeName === "WriteConflict" ||
  Boolean(err?.hasErrorLabel?.("TransientTransactionError"));

/** Maps a transactional route error to a safe response. */
const sendTransactionError = (res, err, route, message, conflictMessage) => {
  if (err?.statusCode) return res.status(err.statusCode).json({ message: err.message });
  if (isConcurrencyError(err)) return res.status(409).json({ message: conflictMessage });
  return sendServerError(res, route, err, message);
};

/** Runs `work(session)` in one transaction; ends the session exactly once. */
const runTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const loadActivePrice = (customerId, itemId, session) =>
  CustomerProductPrice.findOne({ customer: customerId, item: itemId, isActive: true })
    .select("pricePaise")
    .session(session)
    .lean();

const loadFinishedItem = async (itemId, session, fields = "productName unit category currentStock") => {
  const item = await StockItem.findById(itemId).select(fields).session(session).lean();
  if (!item) throw requestError(404, "A selected product was not found.");
  if (item.category !== "finished_goods") {
    throw requestError(400, `${item.productName} is not a Finished Goods product.`);
  }
  return item;
};

/** Conditional deduction: never lets stock go below zero. */
const deductStock = async (itemId, quantity, productName, session) => {
  const updated = await StockItem.findOneAndUpdate(
    { _id: itemId, category: "finished_goods", currentStock: { $gte: quantity } },
    { $inc: { currentStock: -quantity } },
    { new: true, runValidators: true, session }
  );
  if (updated) return updated;

  const current = await StockItem.findById(itemId)
    .select("productName unit currentStock")
    .session(session)
    .lean();
  if (!current) throw requestError(404, `${productName} was not found.`);
  throw requestError(
    409,
    `Insufficient stock for ${current.productName}. Available ${current.currentStock} ${unitLabel(
      current.unit
    )}, required ${quantity} ${unitLabel(current.unit)}.`
  );
};

const returnStock = async (itemId, quantity, productName, session) => {
  const updated = await StockItem.findOneAndUpdate(
    { _id: itemId },
    { $inc: { currentStock: quantity } },
    { new: true, runValidators: true, session }
  );
  if (!updated) throw requestError(409, `${productName} no longer exists; stock cannot be returned.`);
  return updated;
};

/**
 * One StockMovement for a document line. Balances come from the conditional
 * update result, never from an earlier read.
 * `movementTypes` = { out: "estimate_out", in: "estimate_return" } etc.
 */
const buildMovement = ({
  line,
  updatedItem,
  direction,
  quantity,
  referenceType,
  referenceId,
  movementTypes,
  reason,
  actor,
}) => ({
  item: line.item,
  productName: line.productName,
  category: "finished_goods",
  stockType: updatedItem.stockType || null,
  unit: line.unit,
  direction,
  movementType: direction === "out" ? movementTypes.out : movementTypes.in,
  quantity,
  balanceBefore:
    direction === "out" ? updatedItem.currentStock + quantity : updatedItem.currentStock - quantity,
  balanceAfter: updatedItem.currentStock,
  reason: reason.slice(0, 250),
  notes: "",
  referenceType,
  referenceId,
  movementDate: new Date(),
  createdBy: actor,
});

module.exports = {
  actorOf,
  buildMovement,
  deductStock,
  escapeRegex,
  isConcurrencyError,
  loadActivePrice,
  loadFinishedItem,
  requestError,
  returnStock,
  rupees,
  runTransaction,
  sendTransactionError,
  sortByItem,
  unitLabel,
};
