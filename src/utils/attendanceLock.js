const mongoose = require("mongoose");
const Payout = require("../models/Payout");
const BulkPayout = require("../models/BulkPayout");
const Employee = require("../models/Employee");
const { DAY_MS, findCoveringPayouts, toAttendanceDayKey } = require("./payoutOverlap");

const ATTENDANCE_LOCK_CODE = "ATTENDANCE_LOCKED_BY_PAYOUT";
const ATTENDANCE_LOCK_MESSAGE =
  "Attendance is locked because a payout already covers this date. Delete the payout first to edit attendance.";

/**
 * Finds payouts (single Payout or BulkPayout employee line) that cover the
 * given employees on one attendance day.
 *
 * @param {object} args
 * @param {Array<string|ObjectId>} args.employeeIds
 * @param {Date} args.date Attendance date stored at UTC midnight.
 * @param {ClientSession} [args.session]
 * @returns {Promise<Array>} One entry per locked employee; empty when unlocked.
 */
const findAttendanceLocks = async ({ employeeIds = [], date, session = null }) => {
  const dayKey = toAttendanceDayKey(date);
  const ids = [...new Set(employeeIds.map(String))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );
  if (!dayKey || ids.length === 0) return [];

  // Exact query equivalent of "rounded-up start <= day <= rounded-up end"
  // for a UTC-midnight day T: startDate <= T and endDate > T - 1 day.
  const dayStart = new Date(`${dayKey}T00:00:00.000Z`);
  const dateFilter = {
    startDate: { $lte: dayStart },
    endDate: { $gt: new Date(dayStart.getTime() - DAY_MS) },
  };
  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));

  const withSession = (query) => (session ? query.session(session) : query);
  const payoutQuery = () =>
    withSession(
      Payout.find({ employee: { $in: objectIds }, ...dateFilter })
        .select("employee startDate endDate salarySlipNumber")
        .lean()
    );
  const bulkQuery = () =>
    withSession(
      BulkPayout.find({ "employees.employee": { $in: objectIds }, ...dateFilter })
        .select("payoutNumber startDate endDate employees.employee employees.employeeName")
        .lean()
    );
  // A transaction session must never run two operations at once.
  const [legacyPayouts, bulkPayouts] = session
    ? [await payoutQuery(), await bulkQuery()]
    : await Promise.all([payoutQuery(), bulkQuery()]);

  const locked = findCoveringPayouts(legacyPayouts, bulkPayouts, ids, dayKey);

  const missingNames = locked.filter((item) => !item.employeeName).map((item) => item.employeeId);
  if (missingNames.length > 0) {
    const employees = await withSession(
      Employee.find({ _id: { $in: missingNames } }).select("name").lean()
    );
    const nameById = new Map(employees.map((employee) => [String(employee._id), employee.name]));
    locked.forEach((item) => {
      if (!item.employeeName) item.employeeName = nameById.get(item.employeeId) || "";
    });
  }

  return locked;
};

const lockedResponseBody = (locked) => ({
  code: ATTENDANCE_LOCK_CODE,
  message: ATTENDANCE_LOCK_MESSAGE,
  locked,
});

module.exports = {
  ATTENDANCE_LOCK_CODE,
  ATTENDANCE_LOCK_MESSAGE,
  findAttendanceLocks,
  lockedResponseBody,
};
