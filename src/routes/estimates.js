/*
 * Estimates (Step 11B). Admin only; mounted at /api/estimates.
 *
 * No GST or HSN anywhere. Stock is deducted at creation and adjusted by
 * difference on edit, always with StockMovements. Every write runs in one
 * transaction: payloads are validated BEFORE the session opens, every DB call
 * on the session is awaited one at a time, and all per-attempt state is built
 * inside the withTransaction callback because the driver may retry it.
 */
const express = require("express");

const Customer = require("../models/Customer");
const Estimate = require("../models/Estimate");
const EstimateCounter = require("../models/EstimateCounter");
const EstimatePayment = require("../models/EstimatePayment");
const StockMovement = require("../models/StockMovement");
const { buildPagedResponse, parseOptionalPagination } = require("../utils/listQuery");
const { sendServerError } = require("../utils/httpErrors");
const { parseDateOnly } = require("../utils/supplierAccounting");
const { findPriceableProducts } = require("../utils/priceableProducts");
const {
  actorOf,
  buildMovement: buildDocumentMovement,
  deductStock,
  escapeRegex,
  loadActivePrice,
  loadFinishedItem,
  requestError,
  returnStock,
  rupees,
  runTransaction,
  sendTransactionError: sendDocumentTransactionError,
} = require("../utils/salesTransactions");
const {
  ESTIMATE_STATUSES,
  buildSummary,
  canRecordPayment,
  computeStockDiff,
  formatEstimateNumber,
  getFinancialYear,
  isValidId,
  lineTotal,
  sumTotal,
  summarizePayments,
  toDateKey,
  validateCreatePayload,
  validateEditPayload,
  validatePaymentPayload,
  validateReason,
} = require("../utils/estimates");

const router = express.Router();

const ESTIMATE_MOVEMENTS = { out: "estimate_out", in: "estimate_return" };

/** Shared error mapping for every transactional route. */
const sendTransactionError = (res, err, route, message) =>
  sendDocumentTransactionError(
    res,
    err,
    route,
    message,
    "Another update is in progress for this estimate. Please retry."
  );

/* ---------- estimate transactional steps ---------- */

const loadDetail = async (estimateId, session = null) => {
  const estimate = await Estimate.findById(estimateId).session(session).lean();
  if (!estimate) throw requestError(404, "Estimate not found.");
  const payments = await EstimatePayment.find({ estimate: estimateId })
    .sort({ paymentDate: -1, createdAt: -1, _id: -1 })
    .session(session)
    .lean();
  return { estimate, payments, summary: buildSummary(estimate.totalPaise, payments) };
};

/**
 * Locks an active estimate for this transaction by bumping its revision.
 * Concurrent edits, cancels, payments and voids on the same estimate write
 * the same document, so MongoDB serializes them.
 */
const lockActiveEstimate = async (estimateId, actor, session, action) => {
  const estimate = await Estimate.findOneAndUpdate(
    { _id: estimateId, status: "active" },
    { $inc: { revision: 1 }, $set: { updatedBy: actor } },
    { new: true, session, lean: true }
  );
  if (estimate) return estimate;

  const existing = await Estimate.findById(estimateId).select("_id status").session(session).lean();
  if (!existing) throw requestError(404, "Estimate not found.");
  throw requestError(409, `Only active estimates can be ${action}.`);
};

const loadValidPayments = (estimateId, session) =>
  EstimatePayment.find({ estimate: estimateId, voided: false })
    .select("amountPaise voided")
    .session(session)
    .lean();

const buildMovement = ({ estimate, ...rest }) =>
  buildDocumentMovement({
    ...rest,
    referenceType: "estimate",
    referenceId: estimate._id,
    movementTypes: ESTIMATE_MOVEMENTS,
  });

/* ==========================================================
   PRICEABLE PRODUCTS (for the estimate form)
   GET /api/estimates/priceable-products?customer=&search=&page=&limit=
========================================================== */

router.get("/priceable-products", async (req, res) => {
  try {
    const customerId = String(req.query.customer || "");
    if (!isValidId(customerId)) return res.status(400).json({ message: "Select a valid customer." });

    const customerExists = await Customer.exists({ _id: customerId });
    if (!customerExists) return res.status(404).json({ message: "Customer not found." });

    const paging = parseOptionalPagination(
      { page: req.query.page ?? 1, limit: req.query.limit },
      { cap: 100, maxLimit: 100, defaultLimit: 20 }
    );
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    return res.json(await findPriceableProducts(customerId, { search, paging }));
  } catch (err) {
    return sendServerError(res, "ESTIMATE PRODUCTS", err, "Unable to load priced products.");
  }
});

/* ==========================================================
   LIST
   GET /api/estimates?page&limit&customer&status&from&to&search
========================================================== */

router.get("/", async (req, res) => {
  try {
    const filter = {};
    const { customer, status, from, to, search } = req.query;

    if (customer) {
      if (!isValidId(String(customer))) return res.status(400).json({ message: "Invalid customer filter." });
      filter.customer = customer;
    }
    if (status) {
      if (!ESTIMATE_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status filter." });
      filter.status = status;
    }
    if (from || to) {
      filter.estimateDate = {};
      if (from) {
        const start = parseDateOnly(from, "From date");
        if (!start.valid) return res.status(400).json({ message: start.message });
        filter.estimateDate.$gte = start.value;
      }
      if (to) {
        const end = parseDateOnly(to, "To date");
        if (!end.valid) return res.status(400).json({ message: end.message });
        filter.estimateDate.$lte = end.value;
      }
      if (filter.estimateDate.$gte && filter.estimateDate.$lte && filter.estimateDate.$gte > filter.estimateDate.$lte) {
        return res.status(400).json({ message: "From date cannot be after To date." });
      }
    }
    if (typeof search === "string" && search.trim()) {
      filter.estimateNumber = { $regex: escapeRegex(search.trim()), $options: "i" };
    }

    const paging = parseOptionalPagination(
      { page: req.query.page ?? 1, limit: req.query.limit },
      { cap: 100, maxLimit: 100, defaultLimit: 20 }
    );

    const [rows, total] = await Promise.all([
      Estimate.find(filter)
        .select("estimateNumber estimateDate customer customerSnapshot totalPaise status lines._id")
        .sort({ estimateDate: -1, _id: -1 })
        .skip(paging.skip)
        .limit(paging.limit)
        .lean(),
      Estimate.countDocuments(filter),
    ]);

    const paidRows = rows.length
      ? await EstimatePayment.aggregate([
          { $match: { estimate: { $in: rows.map((row) => row._id) }, voided: false } },
          { $group: { _id: "$estimate", paidPaise: { $sum: "$amountPaise" } } },
        ])
      : [];
    const paidByEstimate = new Map(paidRows.map((row) => [String(row._id), row.paidPaise]));

    const items = rows.map((row) => {
      const paidPaise = paidByEstimate.get(String(row._id)) || 0;
      return {
        _id: row._id,
        estimateNumber: row.estimateNumber,
        estimateDate: row.estimateDate,
        customer: row.customer,
        customerName: row.customerSnapshot?.billingName || row.customerSnapshot?.name || "",
        totalPaise: row.totalPaise,
        paidPaise,
        outstandingPaise: row.totalPaise - paidPaise,
        status: row.status,
        lineCount: Array.isArray(row.lines) ? row.lines.length : 0,
      };
    });

    return res.json(buildPagedResponse(items, paging, total));
  } catch (err) {
    return sendServerError(res, "LIST ESTIMATES", err, "Unable to load estimates.");
  }
});

/* ==========================================================
   DETAIL
   GET /api/estimates/:id
========================================================== */

router.get("/:id", async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid estimate ID." });
  try {
    return res.json(await loadDetail(req.params.id));
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    return sendServerError(res, "GET ESTIMATE", err, "Unable to load estimate.");
  }
});

/* ==========================================================
   CREATE
   POST /api/estimates
========================================================== */

router.post("/", async (req, res) => {
  const validation = validateCreatePayload(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  const payload = validation.value;
  const actor = actorOf(req);
  const financialYear = getFinancialYear(payload.estimateDate);
  const orderedLines = [...payload.lines].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));

  try {
    const detail = await runTransaction(async (session) => {
      const customer = await Customer.findById(payload.customer)
        .select("name billingName contactNumber stateCode billingAddress isActive")
        .session(session)
        .lean();
      if (!customer) throw requestError(404, "Customer not found.");
      if (customer.isActive === false) throw requestError(400, "Customer is inactive.");

      // Snapshot every line (product, unit, current customer price).
      const snapshots = new Map();
      for (const line of orderedLines) {
        const item = await loadFinishedItem(line.item, session);
        const price = await loadActivePrice(payload.customer, line.item, session);
        if (!price) {
          throw requestError(400, `${item.productName} has no active price for this customer.`);
        }
        snapshots.set(line.item, {
          item: item._id,
          productName: item.productName,
          unit: item.unit,
          quantity: line.quantity,
          pricePaise: price.pricePaise,
          lineTotalPaise: lineTotal(line.quantity, price.pricePaise),
        });
      }
      const lines = payload.lines.map((line) => snapshots.get(line.item));
      const totalPaise = sumTotal(lines);

      // Deduct stock (conditional; a shortage aborts the whole estimate).
      const updatedItems = new Map();
      for (const line of orderedLines) {
        const snapshot = snapshots.get(line.item);
        updatedItems.set(
          line.item,
          await deductStock(line.item, line.quantity, snapshot.productName, session)
        );
      }

      const counter = await EstimateCounter.findOneAndUpdate(
        { financialYear },
        { $inc: { sequence: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );
      const estimateNumber = formatEstimateNumber(financialYear, counter.sequence);

      const [estimate] = await Estimate.create(
        [
          {
            estimateNumber,
            financialYear,
            sequence: counter.sequence,
            customer: customer._id,
            customerSnapshot: {
              name: customer.name,
              billingName: customer.billingName || "",
              contactNumber:
                customer.contactNumber === undefined || customer.contactNumber === null
                  ? ""
                  : String(customer.contactNumber),
              stateCode: customer.stateCode || "",
              billingAddress: {
                line1: customer.billingAddress?.line1 || "",
                line2: customer.billingAddress?.line2 || "",
                city: customer.billingAddress?.city || "",
                pincode: customer.billingAddress?.pincode || "",
              },
            },
            estimateDate: payload.estimateDate,
            lines,
            totalPaise,
            status: "active",
            notes: payload.notes,
            createdBy: actor,
            updatedBy: actor,
          },
        ],
        { session }
      );

      await StockMovement.create(
        orderedLines.map((line) =>
          buildMovement({
            line: snapshots.get(line.item),
            updatedItem: updatedItems.get(line.item),
            direction: "out",
            quantity: line.quantity,
            estimate,
            reason: `Estimate ${estimateNumber}`,
            actor,
          })
        ),
        { session }
      );

      const plain = typeof estimate.toObject === "function" ? estimate.toObject() : estimate;
      return { estimate: plain, payments: [], summary: buildSummary(totalPaise, []) };
    });

    return res.status(201).json({ message: `Estimate ${detail.estimate.estimateNumber} created.`, ...detail });
  } catch (err) {
    return sendTransactionError(res, err, "CREATE ESTIMATE", "Unable to create estimate.");
  }
});

/* ==========================================================
   EDIT (customer and date fixed; lines and notes editable)
   PUT /api/estimates/:id
========================================================== */

router.put("/:id", async (req, res) => {
  const estimateId = req.params.id;
  if (!isValidId(estimateId)) return res.status(400).json({ message: "Invalid estimate ID." });

  const validation = validateEditPayload(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  const payload = validation.value;
  const actor = actorOf(req);
  const orderedLines = [...payload.lines].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));

  try {
    const detail = await runTransaction(async (session) => {
      const estimate = await lockActiveEstimate(estimateId, actor, session, "edited");
      const { paidPaise } = summarizePayments(await loadValidPayments(estimateId, session));

      const oldByItem = new Map(estimate.lines.map((line) => [String(line.item), line]));

      const snapshots = new Map();
      for (const line of orderedLines) {
        const existing = oldByItem.get(line.item);

        if (existing && !line.reprice) {
          // Unchanged price snapshot; only the quantity may change.
          snapshots.set(line.item, {
            item: existing.item,
            productName: existing.productName,
            unit: existing.unit,
            quantity: line.quantity,
            pricePaise: existing.pricePaise,
            lineTotalPaise: lineTotal(line.quantity, existing.pricePaise),
          });
          continue;
        }

        const item = await loadFinishedItem(line.item, session);
        const price = await loadActivePrice(estimate.customer, line.item, session);
        if (!price) {
          throw requestError(
            400,
            existing
              ? `${existing.productName} has no active price to re-price from.`
              : `${item.productName} has no active price for this customer.`
          );
        }
        snapshots.set(line.item, {
          item: item._id,
          productName: existing ? existing.productName : item.productName,
          unit: existing ? existing.unit : item.unit,
          quantity: line.quantity,
          pricePaise: price.pricePaise,
          lineTotalPaise: lineTotal(line.quantity, price.pricePaise),
        });
      }

      const lines = payload.lines.map((line) => snapshots.get(line.item));
      const totalPaise = sumTotal(lines);
      if (totalPaise < paidPaise) {
        throw requestError(
          409,
          `The new total ${rupees(totalPaise)} is less than the ${rupees(paidPaise)} already paid.`
        );
      }

      const movements = [];
      for (const { item, delta } of computeStockDiff(estimate.lines, lines)) {
        const line = snapshots.get(item) || oldByItem.get(item);
        const updatedItem =
          delta > 0
            ? await deductStock(item, delta, line.productName, session)
            : await returnStock(item, -delta, line.productName, session);
        movements.push(
          buildMovement({
            line,
            updatedItem,
            direction: delta > 0 ? "out" : "in",
            quantity: Math.abs(delta),
            estimate,
            reason: `Estimate ${estimate.estimateNumber} edited`,
            actor,
          })
        );
      }

      await Estimate.updateOne(
        { _id: estimateId },
        { $set: { lines, totalPaise, notes: payload.notes, updatedBy: actor } },
        { session, runValidators: true }
      );

      if (movements.length) await StockMovement.create(movements, { session });

      return loadDetail(estimateId, session);
    });

    return res.json({ message: `Estimate ${detail.estimate.estimateNumber} updated.`, ...detail });
  } catch (err) {
    return sendTransactionError(res, err, "EDIT ESTIMATE", "Unable to update estimate.");
  }
});

/* ==========================================================
   CANCEL (reversal, never delete)
   POST /api/estimates/:id/cancel  { reason }
========================================================== */

router.post("/:id/cancel", async (req, res) => {
  const estimateId = req.params.id;
  if (!isValidId(estimateId)) return res.status(400).json({ message: "Invalid estimate ID." });

  const reason = validateReason((req.body || {}).reason, "Cancellation reason");
  if (!reason.valid) return res.status(400).json({ message: reason.message });

  const actor = actorOf(req);

  try {
    const detail = await runTransaction(async (session) => {
      const estimate = await lockActiveEstimate(estimateId, actor, session, "cancelled");

      const validPayments = await loadValidPayments(estimateId, session);
      if (validPayments.length > 0) {
        throw requestError(409, "Void the recorded payments before cancelling this estimate.");
      }

      const orderedLines = [...estimate.lines].sort((a, b) =>
        String(a.item) < String(b.item) ? -1 : String(a.item) > String(b.item) ? 1 : 0
      );
      const movements = [];
      for (const line of orderedLines) {
        const updatedItem = await returnStock(line.item, line.quantity, line.productName, session);
        movements.push(
          buildMovement({
            line,
            updatedItem,
            direction: "in",
            quantity: line.quantity,
            estimate,
            reason: `Estimate ${estimate.estimateNumber} cancelled: ${reason.value}`,
            actor,
          })
        );
      }

      await Estimate.updateOne(
        { _id: estimateId },
        {
          $set: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledBy: actor,
            cancelReason: reason.value,
            updatedBy: actor,
          },
        },
        { session }
      );

      await StockMovement.create(movements, { session });

      return loadDetail(estimateId, session);
    });

    return res.json({ message: `Estimate ${detail.estimate.estimateNumber} cancelled.`, ...detail });
  } catch (err) {
    return sendTransactionError(res, err, "CANCEL ESTIMATE", "Unable to cancel estimate.");
  }
});

/* ==========================================================
   PAYMENTS
   POST /api/estimates/:id/payments
   POST /api/estimates/:id/payments/:paymentId/void  { reason }
========================================================== */

router.post("/:id/payments", async (req, res) => {
  const estimateId = req.params.id;
  if (!isValidId(estimateId)) return res.status(400).json({ message: "Invalid estimate ID." });

  const validation = validatePaymentPayload(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  const payload = validation.value;
  const actor = actorOf(req);

  try {
    const result = await runTransaction(async (session) => {
      const estimate = await lockActiveEstimate(estimateId, actor, session, "paid");

      if (toDateKey(payload.paymentDate) < toDateKey(estimate.estimateDate)) {
        throw requestError(400, "Payment date cannot be before the estimate date.");
      }

      const { paidPaise } = summarizePayments(await loadValidPayments(estimateId, session));
      const outstandingPaise = estimate.totalPaise - paidPaise;
      if (outstandingPaise <= 0) throw requestError(400, "This estimate is already fully paid.");
      if (!canRecordPayment(outstandingPaise, payload.amountPaise)) {
        throw requestError(
          400,
          `Payment cannot exceed the outstanding balance of ${rupees(outstandingPaise)}.`
        );
      }

      const [payment] = await EstimatePayment.create(
        [
          {
            estimate: estimate._id,
            customer: estimate.customer,
            estimateNumber: estimate.estimateNumber,
            ...payload,
            createdBy: actor,
          },
        ],
        { session }
      );

      const detail = await loadDetail(estimateId, session);
      return {
        payment: typeof payment.toObject === "function" ? payment.toObject() : payment,
        ...detail,
      };
    });

    return res.status(201).json({ message: "Payment recorded.", ...result });
  } catch (err) {
    return sendTransactionError(res, err, "ESTIMATE PAYMENT", "Unable to record payment.");
  }
});

router.post("/:id/payments/:paymentId/void", async (req, res) => {
  const { id: estimateId, paymentId } = req.params;
  if (!isValidId(estimateId)) return res.status(400).json({ message: "Invalid estimate ID." });
  if (!isValidId(paymentId)) return res.status(400).json({ message: "Invalid payment ID." });

  const reason = validateReason((req.body || {}).reason, "Void reason");
  if (!reason.valid) return res.status(400).json({ message: reason.message });

  const actor = actorOf(req);

  try {
    const detail = await runTransaction(async (session) => {
      await lockActiveEstimate(estimateId, actor, session, "changed");

      const voided = await EstimatePayment.findOneAndUpdate(
        { _id: paymentId, estimate: estimateId, voided: false },
        { $set: { voided: true, voidedAt: new Date(), voidedBy: actor, voidReason: reason.value } },
        { new: true, session }
      );
      if (!voided) {
        const existing = await EstimatePayment.findOne({ _id: paymentId, estimate: estimateId })
          .select("_id voided")
          .session(session)
          .lean();
        if (!existing) throw requestError(404, "Payment not found.");
        throw requestError(409, "This payment is already voided.");
      }

      return loadDetail(estimateId, session);
    });

    return res.json({ message: "Payment voided.", ...detail });
  } catch (err) {
    return sendTransactionError(res, err, "VOID ESTIMATE PAYMENT", "Unable to void payment.");
  }
});

module.exports = router;
