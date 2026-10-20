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

module.exports = {
  buildPayoutHistoryByEmployee,
  findOverlappingPayout,
  getOverlapDetails,
};
