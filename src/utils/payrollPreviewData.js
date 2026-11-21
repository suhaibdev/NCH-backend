/*
 * Bounded data loading for the payout preview endpoints.
 *
 * The previews used to load every attendance record and every payout (with all
 * bulk lines) ever created for the employees. What they actually need is:
 *   - attendance inside the payroll period (payroll metrics, marked count),
 *   - per-employee advance totals up to the end date (summed in the database),
 *   - payouts overlapping the period (bulk preview "already created" check).
 * None of these functions use a session; they are safe to run in parallel.
 */
const mongoose = require("mongoose");
const Attendance = require("../models/Attendance");
const Payout = require("../models/Payout");
const BulkPayout = require("../models/BulkPayout");
const { buildPayoutHistoryByEmployee } = require("./payoutOverlap");

const toObjectIds = (ids) => ids.map((id) => new mongoose.Types.ObjectId(String(id)));

/** Attendance with date in [start, end] for the given employees (all employees if null). */
const loadPeriodAttendance = (employeeIds, start, end) => {
  const filter = { date: { $gte: start, $lte: end } };
  if (employeeIds) filter.employee = { $in: toObjectIds(employeeIds) };
  return Attendance.find(filter).lean();
};

/**
 * Per employee: sum of attendance advances with date <= end, and sum of advance
 * recovered by payouts whose period ended on or before `end` (single and bulk).
 * Returns Map<employeeId, { taken, recovered }>.
 */
const loadAdvanceTotals = async (employeeIds, end) => {
  const ids = toObjectIds(employeeIds);

  const [takenRows, legacyRows, bulkRows] = await Promise.all([
    Attendance.aggregate([
      { $match: { employee: { $in: ids }, date: { $lte: end } } },
      { $group: { _id: "$employee", total: { $sum: "$advancePayment" } } },
    ]),
    Payout.aggregate([
      { $match: { employee: { $in: ids }, endDate: { $lte: end } } },
      { $group: { _id: "$employee", total: { $sum: "$advanceDeducted" } } },
    ]),
    BulkPayout.aggregate([
      { $match: { "employees.employee": { $in: ids }, endDate: { $lte: end } } },
      { $unwind: "$employees" },
      { $match: { "employees.employee": { $in: ids } } },
      { $group: { _id: "$employees.employee", total: { $sum: "$employees.advanceDeducted" } } },
    ]),
  ]);

  const totals = new Map(employeeIds.map((id) => [String(id), { taken: 0, recovered: 0 }]));
  const entry = (row) => {
    const key = String(row._id);
    if (!totals.has(key)) totals.set(key, { taken: 0, recovered: 0 });
    return totals.get(key);
  };
  takenRows.forEach((row) => {
    entry(row).taken += Number(row.total) || 0;
  });
  legacyRows.forEach((row) => {
    entry(row).recovered += Number(row.total) || 0;
  });
  bulkRows.forEach((row) => {
    entry(row).recovered += Number(row.total) || 0;
  });
  return totals;
};

/**
 * Payout records (single, then bulk lines) overlapping [start, end], grouped per
 * employee in the same shape as buildPayoutHistoryByEmployee. Bulk parents keep
 * only the requested employees' lines.
 */
const loadOverlappingPayouts = async (employeeIds, start, end) => {
  const ids = toObjectIds(employeeIds);
  const overlap = { startDate: { $lte: end }, endDate: { $gte: start } };

  const [legacyPayouts, bulkPayouts] = await Promise.all([
    Payout.find({ employee: { $in: ids }, ...overlap })
      .select("employee startDate endDate paidOn salarySlipNumber")
      .sort({ _id: 1 })
      .lean(),
    BulkPayout.aggregate([
      { $match: { "employees.employee": { $in: ids }, ...overlap } },
      { $sort: { _id: 1 } },
      {
        $project: {
          payoutNumber: 1,
          startDate: 1,
          endDate: 1,
          paidOn: 1,
          employees: {
            $filter: {
              input: "$employees",
              as: "line",
              cond: { $in: ["$$line.employee", ids] },
            },
          },
        },
      },
    ]),
  ]);

  return buildPayoutHistoryByEmployee(legacyPayouts, bulkPayouts);
};

module.exports = {
  loadAdvanceTotals,
  loadOverlappingPayouts,
  loadPeriodAttendance,
};
