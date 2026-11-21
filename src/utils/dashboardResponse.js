const buildDashboardResponse = ({
  totalEmployees,
  activeEmployees,
  totalCustomers,
  presentToday,
  attendanceMarked,
  monthSalary,
  monthAdvance,
  recentEmployees,
}) => ({
  totalEmployees,
  activeEmployees,
  totalCustomers,
  attendanceToday: presentToday,
  absentToday: Math.max(0, activeEmployees - presentToday),
  attendanceMarked,
  monthSalary: monthSalary.length > 0 ? monthSalary[0].total : 0,
  monthAdvance: monthAdvance.length > 0 ? monthAdvance[0].total : 0,
  recentEmployees,
});

/**
 * Current calendar month as UTC date bounds: [start, end). Independent of the
 * server time zone (same UTC convention as the manufacturing month filter).
 */
const getMonthBounds = (now = new Date()) => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
};

/** Combines the Payout and BulkPayout aggregate results into one rounded total. */
const sumMonthSalary = (payoutAgg, bulkAgg) => {
  const part = (agg) => Number(agg?.[0]?.total) || 0;
  return Math.round((part(payoutAgg) + part(bulkAgg)) * 100) / 100;
};

module.exports = {
  buildDashboardResponse,
  getMonthBounds,
  sumMonthSalary,
};
