/*
 * Delivery Challans (Step 11E). Admin only; mounted at /api/challans.
 *
 * A challan is a manual dispatch record against one invoice. It has NO GST,
 * NO prices, NO stock effect and NO payment/ledger effect: this file never
 * touches StockItem, StockMovement or any payment model. Dispatched quantity
 * per invoice line across active challans can never exceed the line quantity.
 *
 * Create and cancel run in one transaction. Payloads are validated BEFORE the
 * session opens, every DB call on the session is awaited one at a time, and
 * all per-attempt state is built inside the withTransaction callback because
 * the driver may retry it. Concurrent challans for one invoice serialize on
 * the invoice's revision (every writer bumps it first), so two challans can
 * never both take the last quantity.
 */
const express = require("express");
const mongoose = require("mongoose");

const Challan = require("../models/Challan");
const ChallanCounter = require("../models/ChallanCounter");
const Invoice = require("../models/Invoice");
const { buildPagedResponse, parseOptionalPagination } = require("../utils/listQuery");
const { sendServerError } = require("../utils/httpErrors");
const { parseDateOnly } = require("../utils/supplierAccounting");
const {
  actorOf,
  escapeRegex,
  requestError,
  runTransaction,
  sendTransactionError: sendDocumentTransactionError,
} = require("../utils/salesTransactions");
const {
  getFinancialYear,
  isValidId,
  toDateKey,
  validateReason,
} = require("../utils/salesDocuments");
const {
  CHALLAN_STATUSES,
  applyDispatchChange,
  buildDispatchLines,
  formatChallanNumber,
  planDispatch,
  totalQuantity,
  validateCreateChallanPayload,
  validateEditChallanPayload,
} = require("../utils/challans");

const router = express.Router();

const INVOICE_FIELDS =
  "invoiceNumber invoiceDate status customer customerSnapshot seller lines activeChallanCount dispatchStatus revision";

const sendTransactionError = (res, err, route, message) =>
  sendDocumentTransactionError(
    res,
    err,
    route,
    message,
    "Another update is in progress for this invoice. Please retry."
  );

/** Public seller details only: never the GSTIN, PAN or bank. */
const sellerSnapshot = (seller = {}) => ({
  legalName: seller.legalName || "",
  tradeName: seller.tradeName || "",
  addressLine1: seller.addressLine1 || "",
  addressLine2: seller.addressLine2 || "",
  city: seller.city || "",
  pincode: seller.pincode || "",
  stateName: seller.stateName || "",
  phone: seller.phone || "",
  email: seller.email || "",
  signatoryLabel: seller.signatoryLabel || "Authorised Signatory",
});

/** Ship-to: the shipping address, or billing when "same as billing". */
const buildShipTo = (snapshot = {}) => {
  const source =
    snapshot.shippingSameAsBilling === false
      ? { ...(snapshot.shippingAddress || {}) }
      : { ...(snapshot.billingAddress || {}), stateCode: snapshot.stateCode };
  return {
    line1: source.line1 || "",
    line2: source.line2 || "",
    city: source.city || "",
    pincode: source.pincode || "",
    stateCode: source.stateCode || "",
  };
};

/** $inc of the per-line dispatched counters (array filters by invoice line _id). */
const buildInvoiceDispatchUpdate = (deltas, countDelta, dispatchStatus) => {
  const inc = { activeChallanCount: countDelta };
  const arrayFilters = [];
  deltas.forEach(({ invoiceLine, change }, index) => {
    const name = `l${index}`;
    inc[`lines.$[${name}].dispatchedQuantity`] = change;
    arrayFilters.push({ [`${name}._id`]: new mongoose.Types.ObjectId(String(invoiceLine)) });
  });
  return { update: { $inc: inc, $set: { dispatchStatus } }, arrayFilters };
};

/** Bumps the invoice revision (the lock every dispatch writer takes first). */
const lockInvoice = async (invoiceId, actor, session, { requireActive }) => {
  const filter = requireActive ? { _id: invoiceId, status: "active" } : { _id: invoiceId };
  const invoice = await Invoice.findOneAndUpdate(
    filter,
    { $inc: { revision: 1 }, $set: { updatedBy: actor } },
    { new: true, session, lean: true }
  );
  if (invoice) return invoice;

  const existing = await Invoice.findById(invoiceId).select("_id status").session(session).lean();
  if (!existing) throw requestError(404, "Invoice not found.");
  throw requestError(409, "Challans can be created only for active invoices.");
};

const toChallanSummary = (row) => ({
  _id: row._id,
  challanNumber: row.challanNumber,
  challanDate: row.challanDate,
  invoice: row.invoice,
  invoiceNumber: row.invoiceNumber,
  customer: row.customer,
  customerName: row.customerSnapshot?.billingName || row.customerSnapshot?.name || "",
  totalQuantity: totalQuantity(row.lines || []),
  lineCount: Array.isArray(row.lines) ? row.lines.length : 0,
  status: row.status,
});

/* ==========================================================
   DISPATCH PROGRESS OF ONE INVOICE (for the create form and invoice screens)
   GET /api/challans/invoice-dispatch/:invoiceId
========================================================== */

router.get("/invoice-dispatch/:invoiceId", async (req, res) => {
  const { invoiceId } = req.params;
  if (!isValidId(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID." });

  try {
    const invoice = await Invoice.findById(invoiceId).select(INVOICE_FIELDS).lean();
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    const challans = await Challan.find({ invoice: invoiceId })
      .select("challanNumber challanDate status lines.quantity")
      .sort({ challanDate: -1, _id: -1 })
      .limit(200)
      .lean();

    const lines = buildDispatchLines(invoice.lines);
    return res.json({
      invoice: {
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        status: invoice.status,
        customer: invoice.customer,
        customerName:
          invoice.customerSnapshot?.billingName || invoice.customerSnapshot?.name || "",
      },
      dispatchStatus: invoice.dispatchStatus || "none",
      canCreate: invoice.status === "active" && lines.some((line) => line.remainingQuantity > 0),
      lines,
      challans: challans.map((challan) => ({
        _id: challan._id,
        challanNumber: challan.challanNumber,
        challanDate: challan.challanDate,
        status: challan.status,
        totalQuantity: totalQuantity(challan.lines || []),
      })),
    });
  } catch (err) {
    return sendServerError(res, "INVOICE DISPATCH", err, "Unable to load dispatch details.");
  }
});

/* ==========================================================
   LIST
   GET /api/challans?page&limit&customer&invoice&status&from&to&search
========================================================== */

router.get("/", async (req, res) => {
  try {
    const filter = {};
    const { customer, invoice, status, from, to, search } = req.query;

    if (customer) {
      if (!isValidId(String(customer))) return res.status(400).json({ message: "Invalid customer filter." });
      filter.customer = customer;
    }
    if (invoice) {
      if (!isValidId(String(invoice))) return res.status(400).json({ message: "Invalid invoice filter." });
      filter.invoice = invoice;
    }
    if (status) {
      if (!CHALLAN_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status filter." });
      filter.status = status;
    }
    if (from || to) {
      filter.challanDate = {};
      if (from) {
        const start = parseDateOnly(from, "From date");
        if (!start.valid) return res.status(400).json({ message: start.message });
        filter.challanDate.$gte = start.value;
      }
      if (to) {
        const end = parseDateOnly(to, "To date");
        if (!end.valid) return res.status(400).json({ message: end.message });
        filter.challanDate.$lte = end.value;
      }
      if (filter.challanDate.$gte && filter.challanDate.$lte && filter.challanDate.$gte > filter.challanDate.$lte) {
        return res.status(400).json({ message: "From date cannot be after To date." });
      }
    }
    if (typeof search === "string" && search.trim()) {
      filter.challanNumber = { $regex: escapeRegex(search.trim()), $options: "i" };
    }

    const paging = parseOptionalPagination(
      { page: req.query.page ?? 1, limit: req.query.limit },
      { cap: 100, maxLimit: 100, defaultLimit: 20 }
    );

    const [rows, total] = await Promise.all([
      Challan.find(filter)
        .select(
          "challanNumber challanDate invoice invoiceNumber customer customerSnapshot status lines.quantity"
        )
        .sort({ challanDate: -1, _id: -1 })
        .skip(paging.skip)
        .limit(paging.limit)
        .lean(),
      Challan.countDocuments(filter),
    ]);

    return res.json(buildPagedResponse(rows.map(toChallanSummary), paging, total));
  } catch (err) {
    return sendServerError(res, "LIST CHALLANS", err, "Unable to load challans.");
  }
});

/* ==========================================================
   DETAIL
========================================================== */

router.get("/:id", async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid challan ID." });
  try {
    const challan = await Challan.findById(req.params.id).lean();
    if (!challan) return res.status(404).json({ message: "Challan not found." });
    return res.json({ challan });
  } catch (err) {
    return sendServerError(res, "GET CHALLAN", err, "Unable to load challan.");
  }
});

/* ==========================================================
   CREATE
   POST /api/challans
========================================================== */

router.post("/", async (req, res) => {
  const validation = validateCreateChallanPayload(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  const payload = validation.value;
  const actor = actorOf(req);
  const financialYear = getFinancialYear(payload.challanDate);

  try {
    const challan = await runTransaction(async (session) => {
      // Lock the invoice: concurrent challans, edits and reversals of this
      // invoice all bump the same revision, so they run one after another.
      const invoice = await lockInvoice(payload.invoice, actor, session, { requireActive: true });

      if (toDateKey(payload.challanDate) < toDateKey(invoice.invoiceDate)) {
        throw requestError(400, "Challan date cannot be before the invoice date.");
      }

      // The cap: quantity <= ordered - already dispatched on active challans.
      const plan = planDispatch(invoice.lines, payload.lines);
      if (!plan.valid) throw requestError(plan.statusCode, plan.message);

      const change = applyDispatchChange(invoice.lines, plan.value, 1);
      if (!change.valid) throw requestError(change.statusCode, change.message);

      const counter = await ChallanCounter.findOneAndUpdate(
        { financialYear },
        { $inc: { sequence: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );
      const challanNumber = formatChallanNumber(financialYear, counter.sequence);

      const [created] = await Challan.create(
        [
          {
            challanNumber,
            financialYear,
            sequence: counter.sequence,
            invoice: invoice._id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate,
            customer: invoice.customer,
            customerSnapshot: {
              name: invoice.customerSnapshot?.name || "",
              billingName: invoice.customerSnapshot?.billingName || "",
              contactNumber: invoice.customerSnapshot?.contactNumber || "",
              shipTo: buildShipTo(invoice.customerSnapshot),
            },
            seller: sellerSnapshot(invoice.seller),
            challanDate: payload.challanDate,
            lines: plan.value,
            transport: payload.transport,
            notes: payload.notes,
            status: "active",
            createdBy: actor,
            updatedBy: actor,
          },
        ],
        { session }
      );

      const { update, arrayFilters } = buildInvoiceDispatchUpdate(
        change.deltas,
        1,
        change.dispatchStatus
      );
      const updated = await Invoice.updateOne(
        { _id: invoice._id, revision: invoice.revision },
        update,
        { session, arrayFilters }
      );
      if (updated?.matchedCount === 0) {
        throw requestError(409, "The invoice changed while the challan was being created. Please retry.");
      }

      return typeof created.toObject === "function" ? created.toObject() : created;
    });

    return res.status(201).json({ message: `Challan ${challan.challanNumber} created.`, challan });
  } catch (err) {
    return sendTransactionError(res, err, "CREATE CHALLAN", "Unable to create challan.");
  }
});

/* ==========================================================
   EDIT (transport details and notes only)
   PUT /api/challans/:id
========================================================== */

router.put("/:id", async (req, res) => {
  const challanId = req.params.id;
  if (!isValidId(challanId)) return res.status(400).json({ message: "Invalid challan ID." });

  const validation = validateEditChallanPayload(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  const actor = actorOf(req);

  try {
    const challan = await Challan.findOneAndUpdate(
      { _id: challanId, status: "active" },
      { $set: { ...validation.value, updatedBy: actor }, $inc: { revision: 1 } },
      { new: true, lean: true }
    );
    if (!challan) {
      const existing = await Challan.findById(challanId).select("_id status").lean();
      if (!existing) return res.status(404).json({ message: "Challan not found." });
      return res.status(409).json({ message: "Only active challans can be edited." });
    }
    return res.json({ message: `Challan ${challan.challanNumber} updated.`, challan });
  } catch (err) {
    return sendServerError(res, "EDIT CHALLAN", err, "Unable to update challan.");
  }
});

/* ==========================================================
   CANCEL (record kept; quantities return to the remaining pool)
   POST /api/challans/:id/cancel  { reason }
========================================================== */

router.post("/:id/cancel", async (req, res) => {
  const challanId = req.params.id;
  if (!isValidId(challanId)) return res.status(400).json({ message: "Invalid challan ID." });

  const reason = validateReason((req.body || {}).reason, "Cancellation reason");
  if (!reason.valid) return res.status(400).json({ message: reason.message });

  const actor = actorOf(req);

  try {
    const challan = await runTransaction(async (session) => {
      const existing = await Challan.findById(challanId)
        .select("invoice status")
        .session(session)
        .lean();
      if (!existing) throw requestError(404, "Challan not found.");

      // Lock the invoice first (same order as create), then flip the challan.
      const invoice = await lockInvoice(existing.invoice, actor, session, { requireActive: false });

      const cancelled = await Challan.findOneAndUpdate(
        { _id: challanId, status: "active" },
        {
          $set: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledBy: actor,
            cancelReason: reason.value,
            updatedBy: actor,
          },
          $inc: { revision: 1 },
        },
        { new: true, session, lean: true }
      );
      if (!cancelled) throw requestError(409, "This challan is already cancelled.");

      const change = applyDispatchChange(invoice.lines, cancelled.lines, -1);
      if (!change.valid) throw requestError(change.statusCode, change.message);

      const { update, arrayFilters } = buildInvoiceDispatchUpdate(
        change.deltas,
        -1,
        change.dispatchStatus
      );
      const updated = await Invoice.updateOne(
        { _id: invoice._id, revision: invoice.revision },
        update,
        { session, arrayFilters }
      );
      if (updated?.matchedCount === 0) {
        throw requestError(409, "The invoice changed while the challan was being cancelled. Please retry.");
      }

      return cancelled;
    });

    return res.json({ message: `Challan ${challan.challanNumber} cancelled.`, challan });
  } catch (err) {
    return sendTransactionError(res, err, "CANCEL CHALLAN", "Unable to cancel challan.");
  }
});

module.exports = router;
