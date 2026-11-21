const addHistoryRecord = (grouped, employeeId, record) => {
  if (!employeeId) {
    return;
  }

  if (!grouped.has(employeeId)) {
    grouped.set(employeeId, []);
  }

  grouped.get(employeeId).push(record);
};

const buildPayoutHistoryByEmployee = (
  legacyPayouts = [],
  bulkPayouts = []
) => {
  const grouped = new Map();

  legacyPayouts.forEach((payout) => {
    const employeeId = String(payout.employee || "");

    addHistoryRecord(grouped, employeeId, {
      ...payout,
      overlapSource: "legacy",
    });
  });

  bulkPayouts.forEach((bulkPayout) => {
    (bulkPayout.employees || []).forEach((line) => {
      const employeeId = String(line.employee || "");

      addHistoryRecord(grouped, employeeId, {
        ...line,
        _id: bulkPayout._id,
        startDate: bulkPayout.startDate,
        endDate: bulkPayout.endDate,
        paidOn: bulkPayout.paidOn || null,
        overlapSource: "bulk",
        parentBulkPayoutId: bulkPayout._id,
        parentBulkPayoutNumber: bulkPayout.payoutNumber || "",
      });
    });
  });

  return grouped;
};

const findOverlappingPayout = (payoutRecords, start, end) =>
  payoutRecords.find((payout) => {
    if (!payout.startDate || !payout.endDate) {
      return false;
    }

    const payoutStart = new Date(payout.startDate);
    const payoutEnd = new Date(payout.endDate);

    return payoutStart <= end && payoutEnd >= start;
  });

const getOverlapDetails = (payout) => {
  if (!payout) {
    return null;
  }

  const isBulk = payout.overlapSource === "bulk";

  return {
    sourceType: isBulk ? "bulk" : "single",
    sourceLabel: isBulk
      ? payout.parentBulkPayoutNumber
        ? `Bulk Payout #${payout.parentBulkPayoutNumber}`
        : "Bulk Payout"
      : "Single Payout",
    startDate: payout.startDate,
    endDate: payout.endDate,
    paidOn: payout.paidOn || null,
    parentBulkPayout: isBulk
      ? {
          id: payout.parentBulkPayoutId,
          payoutNumber: payout.parentBulkPayoutNumber || "",
        }
      : null,
  };
};

/* ==========================================================
   DAY KEYS (server time zone independent)

   Attendance is stored at UTC midnight of its business date.
   Payout boundaries are stored as either UTC midnight (single payouts
   save the raw "YYYY-MM-DD" string) or server-local midnight (bulk
   payouts save date-fns startOfDay). Rounding a payout boundary UP to
   the next UTC midnight recovers the chosen calendar date for any
   server offset within +/-24h, so comparisons never depend on the
   server's time zone.
========================================================== */

const DAY_MS = 24 * 60 * 60 * 1000;

const toAttendanceDayKey = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const toPayoutDayKey = (value) => {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(Math.ceil(time / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
};

const payoutCoversDay = (payout, dayKey) => {
  if (!payout || !dayKey || !payout.startDate || !payout.endDate) return false;
  const startKey = toPayoutDayKey(payout.startDate);
  const endKey = toPayoutDayKey(payout.endDate);
  return Boolean(startKey && endKey && startKey <= dayKey && dayKey <= endKey);
};

/**
 * Returns at most one covering payout per requested employee for a day.
 * Accepts lean Payout and BulkPayout documents.
 */
const findCoveringPayouts = (legacyPayouts = [], bulkPayouts = [], employeeIds = [], dayKey) => {
  const history = buildPayoutHistoryByEmployee(legacyPayouts, bulkPayouts);
  const seen = new Set();
  const locked = [];

  employeeIds.map(String).forEach((employeeId) => {
    if (seen.has(employeeId)) return;
    seen.add(employeeId);

    const covering = (history.get(employeeId) || []).find((payout) =>
      payoutCoversDay(payout, dayKey)
    );
    if (!covering) return;

    const isBulk = covering.overlapSource === "bulk";
    locked.push({
      employeeId,
      employeeName: isBulk ? covering.employeeName || "" : "",
      sourceType: isBulk ? "bulk" : "single",
      payoutId: isBulk ? covering.parentBulkPayoutId : covering._id,
      payoutNumber: isBulk ? covering.parentBulkPayoutNumber || "" : covering.salarySlipNumber || "",
      startDate: covering.startDate,
      endDate: covering.endDate,
    });
  });

  return locked;
};

/** Payouts whose period ended on or before `end` (same rule bulk payouts use). */
const filterPayoutsEndingBy = (history = [], end) =>
  history.filter((payout) => payout.endDate && new Date(payout.endDate) <= end);

module.exports = {
  DAY_MS,
  buildPayoutHistoryByEmployee,
  filterPayoutsEndingBy,
  findCoveringPayouts,
  findOverlappingPayout,
  getOverlapDetails,
  payoutCoversDay,
  toAttendanceDayKey,
  toPayoutDayKey,
};
