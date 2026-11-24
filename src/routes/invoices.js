/*
 * GST Invoices (Step 11C). Admin only; mounted at /api/invoices.
 *
 * Prices are exclusive of GST. Each line snapshots its price, HSN code and GST
 * rate; tax is computed once per GST-rate group in utils/gstInvoice.js and the
 * grand total is rounded to the rupee with a separate round-off.
 *
 * Every write runs in one transaction: payloads are validated BEFORE the
 * session opens, every DB call on the session is awaited one at a time, and
 * all per-attempt state is built inside the withTransaction callback because
 * the driver may retry it. Shared steps live in utils/salesTransactions.js.
 */
const express = require("express");

const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const InvoiceCounter = require("../models/InvoiceCounter");
const InvoicePayment = require("../models/InvoicePayment");
const StockMovement = require("../models/StockMovement");
const sellerProfile = require("../config/sellerProfile");
const { buildPagedResponse, parseOptionalPagination } = require("../utils/listQuery");
const { sendServerError } = require("../utils/httpErrors");
const { parseDateOnly } = require("../utils/supplierAccounting");
const { findPriceableProducts } = require("../utils/priceableProducts");
const {
  actorOf,
  buildMovement,
  deductStock,
  escapeRegex,
  loadActivePrice,
  loadFinishedItem,
  requestError,
  returnStock,
  rupees,
  runTransaction,
  sendTransactionError: sendDocumentTransactionError,
  sortByItem,
} = require("../utils/salesTransactions");
const {
  buildSummary,
  canRecordPayment,
  computeStockDiff,
  getFinancialYear,
  isValidId,
  lineTotal,
  summarizePayments,
  toDateKey,
  validateCreateDocumentPayload,
  validateEditDocumentPayload,
  validatePaymentPayload,
  validateReason,
} = require("../utils/salesDocuments");
const {
  CUSTOMER_FIELDS,
  buildCustomerSnapshot,
  formatInvoiceNumber,
  taxFields,
} = require("../utils/invoiceSnapshots");
const {
  computeInvoiceTax,
  determineTaxType,
  missingTaxMetadataMessage,
} = require("../utils/gstInvoice");

const router = express.Router();

const INVOICE_STATUSES = ["active", "reversed"];
const INVOICE_MOVEMENTS = { out: "invoice_out", in: "invoice_return" };
const ITEM_FIELDS = "productName unit category currentStock hsnCode gstRatePercent";
const sendTransactionError = (res, err, route, message) =>
  sendDocumentTransactionError(
    res,
    err,
    route,
    message,
    "Another update is in progress for this invoice. Please retry."
  );

/* ---------- invoice transactional steps ---------- */

const loadDetail = async (invoiceId, session = null) => {
  const invoice = await Invoice.findById(invoiceId).session(session).lean();
  if (!invoice) throw requestError(404, "Invoice not found.");
  const payments = await InvoicePayment.find({ invoice: invoiceId })
    .sort({ paymentDate: -1, createdAt: -1, _id: -1 })
    .session(session)
    .lean();
  return { invoice, payments, summary: buildSummary(invoice.totalPaise, payments) };
};

/** Locks an active invoice by bumping its revision (serializes concurrent writes). */
const lockActiveInvoice = async (invoiceId, actor, session, action) => {
  const invoice = await Invoice.findOneAndUpdate(
    { _id: invoiceId, status: "active" },
    { $inc: { revision: 1 }, $set: { updatedBy: actor } },
    { new: true, session, lean: true }
  );
  if (invoice) return invoice;

  const existing = await Invoice.findById(invoiceId).select("_id status").session(session).lean();
  if (!existing) throw requestError(404, "Invoice not found.");
  throw requestError(409, `Only active invoices can be ${action}.`);
};

const loadValidPayments = (invoiceId, session) =>
  InvoicePayment.find({ invoice: invoiceId, voided: false })
    .select("amountPaise voided")
    .session(session)
    .lean();

/** Finished Goods item with complete tax metadata (no silent default for invoices). */
const loadInvoiceItem = async (itemId, session) => {
  const item = await loadFinishedItem(itemId, session, ITEM_FIELDS);
  const missing = missingTaxMetadataMessage(item);
  if (missing) throw requestError(400, missing);
  return item;
};

const snapshotLine = ({ item, productName, unit, hsnCode, gstRatePercent, pricePaise, line }) => ({
  item,
  productName,
  unit,
  hsnCode,
  gstRatePercent,
  quantity: line.quantity,
  pricePaise,
  taxablePaise: lineTotal(line.quantity, pricePaise),
  batchReference: line.batchReference || "",
});

const invoiceMovement = ({ invoice, ...rest }) =>
  buildMovement({
    ...rest,
    referenceType: "invoice",
    referenceId: invoice._id,
    movementTypes: INVOICE_MOVEMENTS,
  });

/* ==========================================================
   FORM SUPPORT
========================================================== */

router.get("/seller-status", (req, res) =>
  res.json({ configured: sellerProfile.isSellerConfigured() })
);

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

    return res.json(await findPriceableProducts(customerId, { search, paging, includeTax: true }));
  } catch (err) {
    return sendServerError(res, "INVOICE PRODUCTS", err, "Unable to load priced products.");
  }
});

/* ==========================================================
   LIST
   GET /api/invoices?page&limit&customer&status&from&to&search
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
      if (!INVOICE_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status filter." });
      filter.status = status;
    }
    if (from || to) {
      filter.invoiceDate = {};
      if (from) {
        const start = parseDateOnly(from, "From date");
        if (!start.valid) return res.status(400).json({ message: start.message });
        filter.invoiceDate.$gte = start.value;
      }
      if (to) {
        const end = parseDateOnly(to, "To date");
        if (!end.valid) return res.status(400).json({ message: end.message });
        filter.invoiceDate.$lte = end.value;
      }
      if (filter.invoiceDate.$gte && filter.invoiceDate.$lte && filter.invoiceDate.$gte > filter.invoiceDate.$lte) {
        return res.status(400).json({ message: "From date cannot be after To date." });
      }
    }
    if (typeof search === "string" && search.trim()) {
      filter.invoiceNumber = { $regex: escapeRegex(search.trim()), $options: "i" };
    }

    const paging = parseOptionalPagination(
      { page: req.query.page ?? 1, limit: req.query.limit },
      { cap: 100, maxLimit: 100, defaultLimit: 20 }
    );

    const [rows, total] = await Promise.all([
      Invoice.find(filter)
        .select(
          "invoiceNumber invoiceDate customer customerSnapshot taxType totalPaise status lines._id sourceEstimateNumber"
        )
        .sort({ invoiceDate: -1, _id: -1 })
        .skip(paging.skip)
        .limit(paging.limit)
        .lean(),
      Invoice.countDocuments(filter),
    ]);

    const paidRows = rows.length
      ? await InvoicePayment.aggregate([
          { $match: { invoice: { $in: rows.map((row) => row._id) }, voided: false } },
          { $group: { _id: "$invoice", paidPaise: { $sum: "$amountPaise" } } },
        ])
      : [];
    const paidByInvoice = new Map(paidRows.map((row) => [String(row._id), row.paidPaise]));

    const items = rows.map((row) => {
      const paidPaise = paidByInvoice.get(String(row._id)) || 0;
      return {
        _id: row._id,
        invoiceNumber: row.invoiceNumber,
        invoiceDate: row.invoiceDate,
        customer: row.customer,
        customerName: row.customerSnapshot?.billingName || row.customerSnapshot?.name || "",
        taxType: row.taxType,
        sourceEstimateNumber: row.sourceEstimateNumber || "",
        totalPaise: row.totalPaise,
        paidPaise,
        outstandingPaise: row.totalPaise - paidPaise,
        status: row.status,
        lineCount: Array.isArray(row.lines) ? row.lines.length : 0,
      };
    });

    return res.json(buildPagedResponse(items, paging, total));
  } catch (err) {
    return sendServerError(res, "LIST INVOICES", err, "Unable to load invoices.");
  }
});

/* ==========================================================
   DETAIL
========================================================== */

router.get("/:id", async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid invoice ID." });
  try {
    return res.json(await loadDetail(req.params.id));
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    return sendServerError(res, "GET INVOICE", err, "Unable to load invoice.");
  }
});

/* ==========================================================
   CREATE
   POST /api/invoices
========================================================== */

router.post("/", async (req, res) => {
  const validation = validateCreateDocumentPayload(req.body, {
    dateField: "invoiceDate",
    dateLabel: "Invoice date",
    noun: "an invoice",
    kind: "invoice",
    allowBatchReference: true,
  });
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  if (!sellerProfile.isSellerConfigured()) {
    return res.status(400).json({
      message: "Seller details are not configured. Invoices cannot be created yet.",
    });
  }

  const payload = validation.value;
  const actor = actorOf(req);
  const financialYear = getFinancialYear(payload.date);
  const orderedLines = sortByItem(payload.lines);
  const seller = sellerProfile.getSellerSnapshot();

  try {
    const detail = await runTransaction(async (session) => {
      const customer = await Customer.findById(payload.customer)
        .select(CUSTOMER_FIELDS)
        .session(session)
        .lean();
      if (!customer) throw requestError(404, "Customer not found.");
      if (customer.isActive === false) throw requestError(400, "Customer is inactive.");

      const taxType = determineTaxType(customer.stateCode);
      if (!taxType) {
        throw requestError(400, "Customer has no valid state. Set the customer's state before invoicing.");
      }

      // Snapshot every line: product, unit, HSN, GST rate and current customer price.
      const snapshots = new Map();
      for (const line of orderedLines) {
        const item = await loadInvoiceItem(line.item, session);
        const price = await loadActivePrice(payload.customer, line.item, session);
        if (!price) {
          throw requestError(400, `${item.productName} has no active price for this customer.`);
        }
        snapshots.set(
          line.item,
          snapshotLine({
            item: item._id,
            productName: item.productName,
            unit: item.unit,
            hsnCode: item.hsnCode,
            gstRatePercent: item.gstRatePercent,
            pricePaise: price.pricePaise,
            line,
          })
        );
      }
      const lines = payload.lines.map((line) => snapshots.get(line.item));
      const tax = computeInvoiceTax(lines, taxType);

      // Deduct stock (conditional; a shortage aborts the whole invoice).
      const updatedItems = new Map();
      for (const line of orderedLines) {
        updatedItems.set(
          line.item,
          await deductStock(line.item, line.quantity, snapshots.get(line.item).productName, session)
        );
      }

      const counter = await InvoiceCounter.findOneAndUpdate(
        { financialYear },
        { $inc: { sequence: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );
      const invoiceNumber = formatInvoiceNumber(financialYear, counter.sequence);

      const [invoice] = await Invoice.create(
        [
          {
            invoiceNumber,
            financialYear,
            sequence: counter.sequence,
            customer: customer._id,
            customerSnapshot: buildCustomerSnapshot(customer),
            seller,
            invoiceDate: payload.date,
            taxType,
            placeOfSupplyStateCode: customer.stateCode,
            lines,
            ...taxFields(tax),
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
          invoiceMovement({
            line: snapshots.get(line.item),
            updatedItem: updatedItems.get(line.item),
            direction: "out",
            quantity: line.quantity,
            invoice,
            reason: `Invoice ${invoiceNumber}`,
            actor,
          })
        ),
        { session }
      );

      const plain = typeof invoice.toObject === "function" ? invoice.toObject() : invoice;
      return { invoice: plain, payments: [], summary: buildSummary(tax.totalPaise, []) };
    });

    return res.status(201).json({ message: `Invoice ${detail.invoice.invoiceNumber} created.`, ...detail });
  } catch (err) {
    return sendTransactionError(res, err, "CREATE INVOICE", "Unable to create invoice.");
  }
});

/* ==========================================================
   EDIT (only while no valid payment exists)
   PUT /api/invoices/:id
========================================================== */

router.put("/:id", async (req, res) => {
  const invoiceId = req.params.id;
  if (!isValidId(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID." });

  const validation = validateEditDocumentPayload(req.body, {
    dateField: "invoiceDate",
    fixedMessage: "Customer and invoice date cannot be changed.",
    noun: "an invoice",
    kind: "invoice",
    allowBatchReference: true,
  });
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  const payload = validation.value;
  const actor = actorOf(req);
  const orderedLines = sortByItem(payload.lines);

  try {
    const detail = await runTransaction(async (session) => {
      const invoice = await lockActiveInvoice(invoiceId, actor, session, "edited");

      const validPayments = await loadValidPayments(invoiceId, session);
      if (validPayments.length > 0) {
        throw requestError(409, "This invoice has payments and is locked. Reverse it instead.");
      }

      const oldByItem = new Map(invoice.lines.map((line) => [String(line.item), line]));

      const snapshots = new Map();
      for (const line of orderedLines) {
        const existing = oldByItem.get(line.item);

        if (existing && !line.reprice) {
          // Kept line: price, HSN and GST rate snapshots stay as issued.
          snapshots.set(
            line.item,
            snapshotLine({
              item: existing.item,
              productName: existing.productName,
              unit: existing.unit,
              hsnCode: existing.hsnCode,
              gstRatePercent: existing.gstRatePercent,
              pricePaise: existing.pricePaise,
              line,
            })
          );
          continue;
        }

        const item = await loadInvoiceItem(line.item, session);
        const price = await loadActivePrice(invoice.customer, line.item, session);
        if (!price) {
          throw requestError(
            400,
            existing
              ? `${existing.productName} has no active price to re-price from.`
              : `${item.productName} has no active price for this customer.`
          );
        }
        snapshots.set(
          line.item,
          snapshotLine({
            item: item._id,
            productName: existing ? existing.productName : item.productName,
            unit: existing ? existing.unit : item.unit,
            hsnCode: item.hsnCode,
            gstRatePercent: item.gstRatePercent,
            pricePaise: price.pricePaise,
            line,
          })
        );
      }

      const lines = payload.lines.map((line) => snapshots.get(line.item));
      // The tax type stays as issued (customer and place of supply are fixed).
      const tax = computeInvoiceTax(lines, invoice.taxType);

      const movements = [];
      for (const { item, delta } of computeStockDiff(invoice.lines, lines)) {
        const line = snapshots.get(item) || oldByItem.get(item);
        const updatedItem =
          delta > 0
            ? await deductStock(item, delta, line.productName, session)
            : await returnStock(item, -delta, line.productName, session);
        movements.push(
          invoiceMovement({
            line,
            updatedItem,
            direction: delta > 0 ? "out" : "in",
            quantity: Math.abs(delta),
            invoice,
            reason: `Invoice ${invoice.invoiceNumber} edited`,
            actor,
          })
        );
      }

      await Invoice.updateOne(
        { _id: invoiceId },
        { $set: { lines, ...taxFields(tax), notes: payload.notes, updatedBy: actor } },
        { session, runValidators: true }
      );

      if (movements.length) await StockMovement.create(movements, { session });

      return loadDetail(invoiceId, session);
    });

    return res.json({ message: `Invoice ${detail.invoice.invoiceNumber} updated.`, ...detail });
  } catch (err) {
    return sendTransactionError(res, err, "EDIT INVOICE", "Unable to update invoice.");
  }
});

/* ==========================================================
   REVERSE (never delete)
   POST /api/invoices/:id/reverse  { reason }
========================================================== */

router.post("/:id/reverse", async (req, res) => {
  const invoiceId = req.params.id;
  if (!isValidId(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID." });

  const reason = validateReason((req.body || {}).reason, "Reversal reason");
  if (!reason.valid) return res.status(400).json({ message: reason.message });

  const actor = actorOf(req);

  try {
    const detail = await runTransaction(async (session) => {
      const invoice = await lockActiveInvoice(invoiceId, actor, session, "reversed");

      const validPayments = await loadValidPayments(invoiceId, session);
      if (validPayments.length > 0) {
        throw requestError(409, "Void the recorded payments before reversing this invoice.");
      }

      const movements = [];
      for (const line of sortByItem(invoice.lines)) {
        const updatedItem = await returnStock(line.item, line.quantity, line.productName, session);
        movements.push(
          invoiceMovement({
            line,
            updatedItem,
            direction: "in",
            quantity: line.quantity,
            invoice,
            reason: `Invoice ${invoice.invoiceNumber} reversed: ${reason.value}`,
            actor,
          })
        );
      }

      await Invoice.updateOne(
        { _id: invoiceId },
        {
          $set: {
            status: "reversed",
            reversedAt: new Date(),
            reversedBy: actor,
            reverseReason: reason.value,
            updatedBy: actor,
          },
        },
        { session }
      );

      await StockMovement.create(movements, { session });

      return loadDetail(invoiceId, session);
    });

    return res.json({ message: `Invoice ${detail.invoice.invoiceNumber} reversed.`, ...detail });
  } catch (err) {
    return sendTransactionError(res, err, "REVERSE INVOICE", "Unable to reverse invoice.");
  }
});

/* ==========================================================
   PAYMENTS
========================================================== */

router.post("/:id/payments", async (req, res) => {
  const invoiceId = req.params.id;
  if (!isValidId(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID." });

  const validation = validatePaymentPayload(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  const payload = validation.value;
  const actor = actorOf(req);

  try {
    const result = await runTransaction(async (session) => {
      const invoice = await lockActiveInvoice(invoiceId, actor, session, "paid");

      if (toDateKey(payload.paymentDate) < toDateKey(invoice.invoiceDate)) {
        throw requestError(400, "Payment date cannot be before the invoice date.");
      }

      const { paidPaise } = summarizePayments(await loadValidPayments(invoiceId, session));
      const outstandingPaise = invoice.totalPaise - paidPaise;
      if (outstandingPaise <= 0) throw requestError(400, "This invoice is already fully paid.");
      if (!canRecordPayment(outstandingPaise, payload.amountPaise)) {
        throw requestError(
          400,
          `Payment cannot exceed the outstanding balance of ${rupees(outstandingPaise)}.`
        );
      }

      const [payment] = await InvoicePayment.create(
        [
          {
            invoice: invoice._id,
            customer: invoice.customer,
            invoiceNumber: invoice.invoiceNumber,
            ...payload,
            createdBy: actor,
          },
        ],
        { session }
      );

      const detail = await loadDetail(invoiceId, session);
      return {
        payment: typeof payment.toObject === "function" ? payment.toObject() : payment,
        ...detail,
      };
    });

    return res.status(201).json({ message: "Payment recorded.", ...result });
  } catch (err) {
    return sendTransactionError(res, err, "INVOICE PAYMENT", "Unable to record payment.");
  }
});

router.post("/:id/payments/:paymentId/void", async (req, res) => {
  const { id: invoiceId, paymentId } = req.params;
  if (!isValidId(invoiceId)) return res.status(400).json({ message: "Invalid invoice ID." });
  if (!isValidId(paymentId)) return res.status(400).json({ message: "Invalid payment ID." });

  const reason = validateReason((req.body || {}).reason, "Void reason");
  if (!reason.valid) return res.status(400).json({ message: reason.message });

  const actor = actorOf(req);

  try {
    const detail = await runTransaction(async (session) => {
      await lockActiveInvoice(invoiceId, actor, session, "changed");

      const voided = await InvoicePayment.findOneAndUpdate(
        { _id: paymentId, invoice: invoiceId, voided: false },
        { $set: { voided: true, voidedAt: new Date(), voidedBy: actor, voidReason: reason.value } },
        { new: true, session }
      );
      if (!voided) {
        const existing = await InvoicePayment.findOne({ _id: paymentId, invoice: invoiceId })
          .select("_id voided")
          .session(session)
          .lean();
        if (!existing) throw requestError(404, "Payment not found.");
        throw requestError(409, "This payment is already voided.");
      }

      return loadDetail(invoiceId, session);
    });

    return res.json({ message: "Payment voided.", ...detail });
  } catch (err) {
    return sendTransactionError(res, err, "VOID INVOICE PAYMENT", "Unable to void payment.");
  }
});

module.exports = router;
