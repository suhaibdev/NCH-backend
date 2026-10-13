const express = require("express");
const mongoose = require("mongoose");

const Supplier = require("../models/Supplier");
const SupplierAccountLock = require("../models/SupplierAccountLock");
const SupplierPayment = require("../models/SupplierPayment");
const {
  PAYMENT_METHODS,
  canRecordPayment,
  cleanOptionalText,
  getSupplierAccountSummary,
  parseDateOnly,
  parseRupeesToPaise,
} = require("../utils/supplierAccounting");

const router = express.Router();

router.post("/", async (req, res) => {
  const body = req.body || {};
  const supplierId = body.supplier;

  if (!mongoose.Types.ObjectId.isValid(supplierId)) {
    return res.status(400).json({ message: "Invalid supplier ID." });
  }

  const amountResult = parseRupeesToPaise(body.amount);
  if (!amountResult.valid) return res.status(400).json({ message: amountResult.message });

  const dateResult = parseDateOnly(body.paymentDate);
  if (!dateResult.valid) return res.status(400).json({ message: dateResult.message });

  const method = String(body.method || "").trim();
  if (!PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({ message: "Payment method is invalid." });
  }

  const referenceResult = cleanOptionalText(body.reference, "Reference", 150);
  const notesResult = cleanOptionalText(body.notes, "Notes", 500);
  if (!referenceResult.valid || !notesResult.valid) {
    return res.status(400).json({ message: referenceResult.message || notesResult.message });
  }

  const session = await mongoose.startSession();
  let responseData;

  try {
    await session.withTransaction(async () => {
      const supplier = await Supplier.findById(supplierId).session(session).lean();
      if (!supplier) {
        throw Object.assign(new Error("Supplier not found."), { statusCode: 404 });
      }

      /*
       * Every payment transaction writes the same supplier-specific document.
       * MongoDB therefore serializes concurrent payment attempts; after a
       * transaction retry, the summary below sees payments already committed.
       */
      await SupplierAccountLock.findOneAndUpdate(
        { supplier: supplier._id },
        {
          $setOnInsert: { supplier: supplier._id },
          $inc: { revision: 1 },
        },
        { new: true, upsert: true, session, setDefaultsOnInsert: true }
      );

      const summaryBefore = await getSupplierAccountSummary(supplier._id, session);
      if (summaryBefore.outstandingPaise <= 0) {
        throw Object.assign(new Error("No outstanding payment is due for this supplier."), { statusCode: 409 });
      }
      if (!canRecordPayment(summaryBefore.outstandingPaise, amountResult.value)) {
        throw Object.assign(
          new Error(`Payment cannot exceed the outstanding balance of ₹${(summaryBefore.outstandingPaise / 100).toFixed(2)}.`),
          { statusCode: 400 }
        );
      }

      const created = await SupplierPayment.create([
        {
          supplier: supplier._id,
          supplierName: supplier.name,
          amountPaise: amountResult.value,
          paymentDate: dateResult.value,
          method,
          reference: referenceResult.value,
          notes: notesResult.value,
          createdBy: req.user?.id || "Admin",
        },
      ], { session });

      responseData = {
        payment: created[0].toObject(),
        summary: await getSupplierAccountSummary(supplier._id, session),
      };
    });

    return res.status(201).json({
      message: "Payment recorded successfully.",
      ...responseData,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    if (err?.code === 11000 || err?.hasErrorLabel?.("TransientTransactionError")) {
      return res.status(409).json({
        message: "Another payment is being recorded for this supplier. Please retry.",
      });
    }
    console.error("CREATE SUPPLIER PAYMENT ERROR:", err);
    return res.status(500).json({ message: "Unable to record supplier payment." });
  } finally {
    await session.endSession();
  }
});

module.exports = router;
