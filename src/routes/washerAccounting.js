const express = require("express");
const mongoose = require("mongoose");
const Washer = require("../models/Washer");
const WasherAdvance = require("../models/WasherAdvance");
const WasherPayout = require("../models/WasherPayout");
const WasherPayoutCounter = require("../models/WasherPayoutCounter");
const WashingProcess = require("../models/WashingProcess");
const { parseMoneyToPaise, parseDateOnly } = require("../utils/washing");

const router = express.Router();
const METHODS = ["cash", "bank_transfer", "upi", "cheque", "other"];
const pageOf = (value, fallback, max) => {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number >= 1 && number <= max ? number : null;
};
const money = (paise) => (Number(paise || 0) / 100).toFixed(2);
const validId = (value, message) => (mongoose.Types.ObjectId.isValid(value) ? null : message);
const clean = (value, max, label) => {
  const text = String(value || "").trim();
  return text.length <= max
    ? { valid: true, value: text }
    : { valid: false, message: `${label} must be ${max} characters or fewer.` };
};
const formatAdvance = (advance) => ({
  ...advance,
  amount: money(advance.amountPaise),
  recovered: money(advance.recoveredPaise),
  remaining: money(advance.amountPaise - advance.recoveredPaise),
});
const formatPayout = (payout) => ({
  ...payout,
  grossEarnings: money(payout.grossEarningsPaise),
  advanceDeduction: money(payout.advanceDeductionPaise),
  netPaid: money(payout.netPaidPaise),
  outstandingAdvanceBefore: money(payout.outstandingAdvanceBeforePaise),
  outstandingAdvanceAfter: money(payout.outstandingAdvanceAfterPaise),
  lines: (payout.lines || []).map((line) => ({
    ...line,
    ratePerPiece: money(line.ratePerPiecePaise),
    amount: money(line.amountPaise),
  })),
});
const outstandingAdvance = async (washer, session) => {
  const rows = await WasherAdvance.aggregate([
    { $match: { washer: new mongoose.Types.ObjectId(washer) } },
    {
      $group: {
        _id: null,
        amount: { $sum: "$amountPaise" },
        recovered: { $sum: "$recoveredPaise" },
      },
    },
  ]).session(session);
  return Math.max(0, Number(rows[0]?.amount || 0) - Number(rows[0]?.recovered || 0));
};
const processQuery = (washer, start, end) => ({
  washer,
  status: "completed",
  settlementStatus: "unpaid",
  washerPayout: null,
  completedDate: { $gte: start, $lte: end },
});
const getEligible = async (washer, start, end, session) =>
  WashingProcess.find(processQuery(washer, start, end))
    .select(
      "_id destinationStockTypeName quantity ratePerPiecePaise earnedAmountPaise completedDate"
    )
    .sort({ completedDate: 1, _id: 1 })
    .session(session)
    .lean();
const generateNumber = async (date, session) => {
  const year = date.getUTCFullYear();
  const counter = await WasherPayoutCounter.findOneAndUpdate(
    { year },
    { $inc: { sequence: 1 }, $setOnInsert: { year } },
    { upsert: true, new: true, session, setDefaultsOnInsert: true }
  );
  return `WP-${year}-${String(counter.sequence).padStart(4, "0")}`;
};

router.get("/:washerId/account-summary", async (req, res) => {
  if (validId(req.params.washerId, "Invalid washer ID."))
    return res.status(400).json({ message: "Invalid washer ID." });
  try {
    const washer = await Washer.findById(req.params.washerId).select("_id name").lean();
    if (!washer) return res.status(404).json({ message: "Washer not found." });
    const [unpaid, advance, paid] = await Promise.all([
      WashingProcess.aggregate([
        { $match: { washer: washer._id, status: "completed", settlementStatus: "unpaid" } },
        { $group: { _id: null, total: { $sum: "$earnedAmountPaise" } } },
      ]),
      outstandingAdvance(washer._id),
      WasherPayout.aggregate([
        { $match: { washer: washer._id } },
        { $group: { _id: null, total: { $sum: "$netPaidPaise" } } },
      ]),
    ]);
    const unpaidPaise = Number(unpaid[0]?.total || 0);
    return res.json({
      washer,
      unpaidEarningsPaise: unpaidPaise,
      outstandingAdvancePaise: advance,
      estimatedNetPayablePaise: Math.max(0, unpaidPaise - advance),
      totalPaidPaise: Number(paid[0]?.total || 0),
      unpaidEarnings: money(unpaidPaise),
      outstandingAdvance: money(advance),
      estimatedNetPayable: money(Math.max(0, unpaidPaise - advance)),
      totalPaid: money(Number(paid[0]?.total || 0)),
    });
  } catch (err) {
    console.error("WASHER SUMMARY ERROR:", err);
    return res.status(500).json({ message: "Unable to load washer summary." });
  }
});

router.get("/:washerId/advances", async (req, res) => {
  if (validId(req.params.washerId)) return res.status(400).json({ message: "Invalid washer ID." });
  const page = pageOf(req.query.page, 1, 1000000),
    limit = pageOf(req.query.limit, 20, 100);
  if (!page || !limit) return res.status(400).json({ message: "Invalid page or limit." });
  try {
    const [items, totalItems] = await Promise.all([
      WasherAdvance.find({ washer: req.params.washerId })
        .sort({ advanceDate: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WasherAdvance.countDocuments({ washer: req.params.washerId }),
    ]);
    return res.json({
      items: items.map(formatAdvance),
      pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
    });
  } catch (err) {
    return res.status(500).json({ message: "Unable to load washer advances." });
  }
});

router.post("/advances", async (req, res) => {
  const body = req.body || {};
  const invalid = validId(body.washer, "Invalid washer ID.");
  const amount = parseMoneyToPaise(body.amount, "Advance amount");
  const date = parseDateOnly(body.advanceDate, "Advance date");
  const reference = clean(body.reference, 150, "Reference"),
    notes = clean(body.notes, 500, "Notes");
  if (
    invalid ||
    !amount.valid ||
    amount.value < 1 ||
    !date.valid ||
    !METHODS.includes(body.method) ||
    !reference.valid ||
    !notes.valid
  )
    return res.status(400).json({
      message:
        invalid ||
        amount.message ||
        date.message ||
        reference.message ||
        notes.message ||
        "Select a valid payment method.",
    });
  try {
    const washer = await Washer.findById(body.washer).select("name").lean();
    if (!washer) return res.status(404).json({ message: "Washer not found." });
    const advance = await WasherAdvance.create({
      washer: washer._id,
      washerName: washer.name,
      amountPaise: amount.value,
      advanceDate: date.value,
      method: body.method,
      reference: reference.value,
      notes: notes.value,
      createdBy: req.user?.id || "Admin",
    });
    return res
      .status(201)
      .json({ message: "Washer advance recorded.", advance: formatAdvance(advance.toObject()) });
  } catch (err) {
    console.error("WASHER ADVANCE ERROR:", err);
    return res.status(500).json({ message: "Unable to record washer advance." });
  }
});

router.get("/:washerId/payout-preview", async (req, res) => {
  const invalid = validId(req.params.washerId, "Invalid washer ID.");
  const start = parseDateOnly(req.query.periodStart, "Period start"),
    end = parseDateOnly(req.query.periodEnd, "Period end");
  if (invalid || !start.valid || !end.valid || start.value > end.value)
    return res.status(400).json({
      message:
        invalid || start.message || end.message || "Period end cannot be before period start.",
    });
  try {
    const washer = await Washer.findById(req.params.washerId).select("name").lean();
    if (!washer) return res.status(404).json({ message: "Washer not found." });
    const [processes, advance] = await Promise.all([
      getEligible(washer._id, start.value, end.value),
      outstandingAdvance(washer._id),
    ]);
    const gross = processes.reduce(
      (total, process) => total + Number(process.earnedAmountPaise || 0),
      0
    );
    const deduction = Math.min(gross, advance);
    return res.json({
      washer,
      processes: processes.map((process) => ({
        ...process,
        ratePerPiece: money(process.ratePerPiecePaise),
        amount: money(process.earnedAmountPaise),
      })),
      grossEarningsPaise: gross,
      outstandingAdvancePaise: advance,
      advanceDeductionPaise: deduction,
      netPaidPaise: gross - deduction,
      grossEarnings: money(gross),
      outstandingAdvance: money(advance),
      advanceDeduction: money(deduction),
      netPaid: money(gross - deduction),
    });
  } catch (err) {
    console.error("WASHER PAYOUT PREVIEW ERROR:", err);
    return res.status(500).json({ message: "Unable to prepare payout." });
  }
});

router.get("/:washerId/payouts", async (req, res) => {
  if (validId(req.params.washerId)) return res.status(400).json({ message: "Invalid washer ID." });
  const page = pageOf(req.query.page, 1, 1000000),
    limit = pageOf(req.query.limit, 20, 100);
  if (!page || !limit) return res.status(400).json({ message: "Invalid page or limit." });
  try {
    const [items, totalItems] = await Promise.all([
      WasherPayout.find({ washer: req.params.washerId })
        .select(
          "payoutNumber washerName periodStart periodEnd grossEarningsPaise advanceDeductionPaise netPaidPaise payoutDate paymentMethod paymentReference status lines"
        )
        .sort({ payoutDate: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WasherPayout.countDocuments({ washer: req.params.washerId }),
    ]);
    return res.json({
      items: items.map(formatPayout),
      pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
    });
  } catch (err) {
    return res.status(500).json({ message: "Unable to load washer payouts." });
  }
});

router.get("/:washerId/payouts/:payoutId", async (req, res) => {
  if (validId(req.params.washerId) || validId(req.params.payoutId))
    return res.status(400).json({ message: "Invalid washer or payout ID." });
  try {
    const payout = await WasherPayout.findOne({
      _id: req.params.payoutId,
      washer: req.params.washerId,
    }).lean();
    if (!payout) return res.status(404).json({ message: "Washer payout not found." });
    return res.json({ payout: formatPayout(payout) });
  } catch (err) {
    return res.status(500).json({ message: "Unable to load washer payout." });
  }
});

router.post("/payouts", async (req, res) => {
  const body = req.body || {};
  const invalid = validId(body.washer, "Invalid washer ID."),
    start = parseDateOnly(body.periodStart, "Period start"),
    end = parseDateOnly(body.periodEnd, "Period end"),
    payoutDate = parseDateOnly(body.payoutDate, "Payout date"),
    reference = clean(body.paymentReference, 150, "Payment reference");
  if (
    invalid ||
    !start.valid ||
    !end.valid ||
    start.value > end.value ||
    !payoutDate.valid ||
    !METHODS.includes(body.paymentMethod) ||
    !reference.valid
  )
    return res.status(400).json({
      message:
        invalid ||
        start.message ||
        end.message ||
        payoutDate.message ||
        reference.message ||
        "Select a valid payment method.",
    });
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const washer = await Washer.findOne({ _id: body.washer, isActive: true })
        .session(session)
        .lean();
      if (!washer)
        throw Object.assign(new Error("Washer was not found or is inactive."), { statusCode: 400 });
      const processes = await getEligible(washer._id, start.value, end.value, session);
      if (!processes.length)
        throw Object.assign(
          new Error("No completed unpaid washing batches are eligible for this period."),
          { statusCode: 400 }
        );
      const gross = processes.reduce(
        (total, process) => total + Number(process.earnedAmountPaise || 0),
        0
      );
      const advanceBefore = await outstandingAdvance(washer._id, session);
      const deduction = Math.min(gross, advanceBefore);
      let remaining = deduction;
      const advances = await WasherAdvance.find({
        washer: washer._id,
        $expr: { $lt: ["$recoveredPaise", "$amountPaise"] },
      })
        .sort({ advanceDate: 1, _id: 1 })
        .session(session);
      const recoveries = [];
      for (const advance of advances) {
        if (!remaining) break;
        const applied = Math.min(remaining, advance.amountPaise - advance.recoveredPaise);
        const updated = await WasherAdvance.findOneAndUpdate(
          { _id: advance._id, recoveredPaise: advance.recoveredPaise },
          { $inc: { recoveredPaise: applied } },
          { new: true, session }
        );
        if (!updated)
          throw Object.assign(new Error("An advance changed during payout. Please retry."), {
            statusCode: 409,
          });
        recoveries.push({ advance: advance._id, amountPaise: applied });
        remaining -= applied;
      }
      if (remaining)
        throw Object.assign(new Error("Advance recovery changed during payout. Please retry."), {
          statusCode: 409,
        });
      const payoutNumber = await generateNumber(payoutDate.value, session);
      const created = await WasherPayout.create(
        [
          {
            payoutNumber,
            washer: washer._id,
            washerName: washer.name,
            periodStart: start.value,
            periodEnd: end.value,
            washingProcesses: processes.map((process) => process._id),
            lines: processes.map((process) => ({
              process: process._id,
              outputTypeName: process.destinationStockTypeName,
              quantity: process.quantity,
              ratePerPiecePaise: process.ratePerPiecePaise,
              amountPaise: process.earnedAmountPaise,
            })),
            grossEarningsPaise: gross,
            outstandingAdvanceBeforePaise: advanceBefore,
            advanceDeductionPaise: deduction,
            outstandingAdvanceAfterPaise: advanceBefore - deduction,
            advanceRecoveries: recoveries,
            netPaidPaise: gross - deduction,
            payoutDate: payoutDate.value,
            paymentMethod: body.paymentMethod,
            paymentReference: reference.value,
            createdBy: req.user?.id || "Admin",
          },
        ],
        { session }
      );
      const payout = created[0];
      const settled = await WashingProcess.updateMany(
        {
          _id: { $in: processes.map((process) => process._id) },
          status: "completed",
          settlementStatus: "unpaid",
          washerPayout: null,
        },
        { $set: { settlementStatus: "paid", washerPayout: payout._id } },
        { session }
      );
      if (settled.modifiedCount !== processes.length)
        throw Object.assign(new Error("A washing batch was already settled. Please retry."), {
          statusCode: 409,
        });
      result = formatPayout(payout.toObject());
    });
    return res
      .status(201)
      .json({ message: "Washer payout generated and paid successfully.", payout: result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    if (err?.code === 11000)
      return res.status(409).json({ message: "A payout conflict occurred. Please retry." });
    console.error("CREATE WASHER PAYOUT ERROR:", err);
    return res.status(500).json({ message: "Unable to generate washer payout." });
  } finally {
    await session.endSession();
  }
});

router.get("/payouts/:id", async (req, res) => {
  if (validId(req.params.id)) return res.status(400).json({ message: "Invalid payout ID." });
  try {
    const payout = await WasherPayout.findById(req.params.id).lean();
    if (!payout) return res.status(404).json({ message: "Washer payout not found." });
    return res.json({ payout: formatPayout(payout) });
  } catch (err) {
    return res.status(500).json({ message: "Unable to load washer payout." });
  }
});
router.validation = Object.freeze({ money, processQuery });
module.exports = router;
