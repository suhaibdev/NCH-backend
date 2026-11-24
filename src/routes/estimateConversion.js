/*
 * Estimate to Invoice conversion (Step 11D). Admin only; mounted at
 * /api/estimates alongside the estimate routes.
 *
 * Conversion NEVER touches stock: the estimate already deducted it, so no
 * StockItem update and no StockMovement is written here. The estimate becomes
 * `converted` (read-only, linked to the invoice), valid estimate payments are
 * carried over to the invoice ledger, and the invoice is created with the
 * normal 11C rules (own number series, GST once per rate group, round-off).
 *
 * Validation runs BEFORE the session opens; every DB call on the session is
 * awaited one at a time; all per-attempt state is built inside the
 * withTransaction callback because the driver may retry it.
 */
const express = require("express");

const Customer = require("../models/Customer");
const Estimate = require("../models/Estimate");
const EstimatePayment = require("../models/EstimatePayment");
const Invoice = require("../models/Invoice");
const InvoiceCounter = require("../models/InvoiceCounter");
const InvoicePayment = require("../models/InvoicePayment");
const StockItem = require("../models/StockItem");
const sellerProfile = require("../config/sellerProfile");
const { sendServerError } = require("../utils/httpErrors");
const { determineTaxType } = require("../utils/gstInvoice");
const {
  CUSTOMER_FIELDS,
  buildCustomerSnapshot,
  formatInvoiceNumber,
  taxFields,
} = require("../utils/invoiceSnapshots");
const {
  buildConversionLines,
  notConvertibleMessage,
  planCarryOver,
  planConversionTax,
  validateConvertPayload,
} = require("../utils/estimateConversion");
const {
  actorOf,
  requestError,
  runTransaction,
  sendTransactionError: sendDocumentTransactionError,
  sortByItem,
} = require("../utils/salesTransactions");
const {
  buildSummary,
  getFinancialYear,
  isValidId,
  toDateKey,
} = require("../utils/salesDocuments");

const router = express.Router();

const ITEM_FIELDS = "productName category hsnCode gstRatePercent";

const sendTransactionError = (res, err, route, message) =>
  sendDocumentTransactionError(
    res,
    err,
    route,
    message,
    "Another update is in progress for this estimate. Please retry."
  );

/**
 * Reads everything the conversion needs and works out the invoice. Every
 * read uses `session` one after another (session may be null for the
 * read-only preview). Problems are collected, never thrown, so the preview
 * can list them all; the convert route throws the first one.
 */
const planConversion = async (estimate, session, batchByItem = new Map()) => {
  const problems = [];

  const customer = await Customer.findById(estimate.customer)
    .select(CUSTOMER_FIELDS)
    .session(session)
    .lean();

  let taxType = null;
  if (!customer) {
    problems.push("Customer not found.");
  } else if (customer.isActive === false) {
    problems.push("Customer is inactive.");
  } else {
    taxType = determineTaxType(customer.stateCode);
    if (!taxType) {
      problems.push("Customer has no valid state. Set the customer's state before invoicing.");
    }
  }

  const itemsById = new Map();
  for (const line of sortByItem(estimate.lines)) {
    const item = await StockItem.findById(line.item).select(ITEM_FIELDS).session(session).lean();
    if (item) itemsById.set(String(line.item), item);
  }

  const built = buildConversionLines(estimate.lines, itemsById, batchByItem);
  problems.push(...built.problems);

  let tax = null;
  if (taxType && built.problems.length === 0) {
    const planned = planConversionTax(built.lines, taxType);
    tax = planned.tax;
    if (planned.problem) problems.push(planned.problem);
  }

  const payments = await EstimatePayment.find({
    estimate: estimate._id,
    voided: false,
    transferred: { $ne: true },
  })
    .sort({ paymentDate: 1, createdAt: 1, _id: 1 })
    .session(session)
    .lean();
  const carry = planCarryOver(payments, tax ? tax.totalPaise : null);

  return { customer, taxType, lines: built.lines, tax, problems, carry };
};

/* ==========================================================
   PREVIEW (read-only): what the invoice would look like
   GET /api/estimates/:id/conversion-preview
========================================================== */

router.get("/:id/conversion-preview", async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid estimate ID." });

  try {
    const estimate = await Estimate.findById(req.params.id).lean();
    if (!estimate) return res.status(404).json({ message: "Estimate not found." });

    const sellerConfigured = sellerProfile.isSellerConfigured();
    const statusProblem = notConvertibleMessage(estimate);

    const base = {
      estimateNumber: estimate.estimateNumber,
      estimateDate: estimate.estimateDate,
      estimateTotalPaise: estimate.totalPaise,
      sellerConfigured,
    };

    if (statusProblem) {
      return res.json({
        ...base,
        eligible: false,
        problems: [statusProblem],
        taxType: null,
        customer: null,
        lines: [],
        tax: null,
        carriedPaymentsPaise: 0,
        carriedPaymentCount: 0,
      });
    }

    const plan = await planConversion(estimate, null);
    const problems = [...plan.problems];
    if (plan.carry.exceedsTotal) {
      problems.push("The amount already paid is more than the invoice total.");
    }
    if (!sellerConfigured) {
      problems.push("Seller details are not configured. Invoices cannot be created yet.");
    }

    return res.json({
      ...base,
      eligible: problems.length === 0,
      problems,
      taxType: plan.taxType,
      customer: plan.customer
        ? {
            name: plan.customer.billingName || plan.customer.name,
            gstin: plan.customer.gst || "",
            stateCode: plan.customer.stateCode || "",
          }
        : null,
      lines: plan.lines,
      tax: plan.tax,
      carriedPaymentsPaise: plan.carry.paidPaise,
      carriedPaymentCount: plan.carry.count,
    });
  } catch (err) {
    return sendServerError(res, "CONVERSION PREVIEW", err, "Unable to prepare the conversion.");
  }
});

/* ==========================================================
   CONVERT
   POST /api/estimates/:id/convert  { invoiceDate?, notes?, lines?: [{item, batchReference}] }
========================================================== */

router.post("/:id/convert", async (req, res) => {
  const estimateId = req.params.id;
  if (!isValidId(estimateId)) return res.status(400).json({ message: "Invalid estimate ID." });

  const validation = validateConvertPayload(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.message });

  if (!sellerProfile.isSellerConfigured()) {
    return res.status(400).json({
      message: "Seller details are not configured. Invoices cannot be created yet.",
    });
  }

  const payload = validation.value;
  const actor = actorOf(req);
  const seller = sellerProfile.getSellerSnapshot();
  const financialYear = getFinancialYear(payload.invoiceDate);

  try {
    const detail = await runTransaction(async (session) => {
      // Claim the estimate: concurrent conversions, edits, cancels, payments
      // and voids all bump this revision while the estimate is active.
      const estimate = await Estimate.findOneAndUpdate(
        { _id: estimateId, status: "active" },
        { $inc: { revision: 1 }, $set: { updatedBy: actor } },
        { new: true, session, lean: true }
      );
      if (!estimate) {
        const existing = await Estimate.findById(estimateId)
          .select("_id status convertedInvoiceNumber")
          .session(session)
          .lean();
        if (!existing) throw requestError(404, "Estimate not found.");
        throw requestError(409, notConvertibleMessage(existing) || "This estimate cannot be converted.");
      }

      if (toDateKey(payload.invoiceDate) < toDateKey(estimate.estimateDate)) {
        throw requestError(400, "Invoice date cannot be before the estimate date.");
      }

      const knownItems = new Set(estimate.lines.map((line) => String(line.item)));
      for (const item of payload.batchByItem.keys()) {
        if (!knownItems.has(item)) {
          throw requestError(400, "A batch reference was sent for a product not on this estimate.");
        }
      }

      const plan = await planConversion(estimate, session, payload.batchByItem);
      if (plan.problems.length > 0) throw requestError(400, plan.problems[0]);
      if (plan.carry.exceedsTotal) {
        throw requestError(
          409,
          "The amount already paid on the estimate is more than the invoice total."
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
            customer: plan.customer._id,
            customerSnapshot: buildCustomerSnapshot(plan.customer),
            seller,
            invoiceDate: payload.invoiceDate,
            taxType: plan.taxType,
            placeOfSupplyStateCode: plan.customer.stateCode,
            lines: plan.lines,
            ...taxFields(plan.tax),
            status: "active",
            notes: payload.notes || `Converted from ${estimate.estimateNumber}`,
            createdBy: actor,
            updatedBy: actor,
            sourceEstimate: estimate._id,
            sourceEstimateNumber: estimate.estimateNumber,
          },
        ],
        { session }
      );

      // Carry the valid estimate payments over to the invoice ledger. The
      // estimate payments are kept (marked transferred), never voided.
      if (plan.carry.count > 0) {
        const created = await InvoicePayment.create(
          plan.carry.payments.map((payment) => ({
            invoice: invoice._id,
            customer: estimate.customer,
            invoiceNumber,
            amountPaise: payment.amountPaise,
            paymentDate: payment.paymentDate,
            method: payment.method,
            reference: payment.reference || "",
            notes: payment.notes || "",
            createdBy: payment.createdBy || actor,
            carriedFromEstimatePayment: payment._id,
            carriedFromEstimateNumber: estimate.estimateNumber,
          })),
          { session, ordered: true }
        );

        const transferredAt = new Date();
        const result = await EstimatePayment.bulkWrite(
          plan.carry.payments.map((payment, index) => ({
            updateOne: {
              filter: { _id: payment._id, voided: false, transferred: { $ne: true } },
              update: {
                $set: {
                  transferred: true,
                  transferredAt,
                  transferredToInvoice: invoice._id,
                  transferredInvoiceNumber: invoiceNumber,
                  transferredInvoicePayment: created[index]._id,
                },
              },
            },
          })),
          { session }
        );
        if ((result?.modifiedCount ?? plan.carry.count) !== plan.carry.count) {
          throw requestError(409, "A payment changed during conversion. Please retry.");
        }
      }

      const updated = await Estimate.updateOne(
        { _id: estimate._id, status: "active" },
        {
          $set: {
            status: "converted",
            convertedInvoice: invoice._id,
            convertedInvoiceNumber: invoiceNumber,
            convertedAt: new Date(),
            convertedBy: actor,
            updatedBy: actor,
          },
        },
        { session }
      );
      if (updated?.matchedCount === 0) {
        throw requestError(409, "This estimate can no longer be converted.");
      }

      const savedInvoice = await Invoice.findById(invoice._id).session(session).lean();
      const payments = await InvoicePayment.find({ invoice: invoice._id })
        .sort({ paymentDate: -1, createdAt: -1, _id: -1 })
        .session(session)
        .lean();
      return {
        invoice: savedInvoice,
        payments,
        summary: buildSummary(savedInvoice.totalPaise, payments),
      };
    });

    return res.status(201).json({
      message: `Invoice ${detail.invoice.invoiceNumber} created from ${detail.invoice.sourceEstimateNumber}.`,
      ...detail,
    });
  } catch (err) {
    return sendTransactionError(res, err, "CONVERT ESTIMATE", "Unable to convert estimate.");
  }
});

module.exports = router;
