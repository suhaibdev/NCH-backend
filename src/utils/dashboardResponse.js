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

// India Standard Time is a fixed +05:30 with no daylight saving.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The IST calendar month containing `now`, as { year, month } (month 0-11). */
const getIstYearMonth = (now = new Date()) => {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() };
};

/**
 * Current IST calendar month as instants: [start, end), i.e. IST midnight of the
 * 1st to IST midnight of the next 1st. Independent of the server time zone.
 */
const getMonthBounds = (now = new Date()) => {
  const { year, month } = getIstYearMonth(now);
  return {
    start: new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(year, month + 1, 1) - IST_OFFSET_MS),
  };
};

/**
 * First day of the IST month at UTC midnight. Attendance dates are stored at UTC
 * midnight of the business date, so this is the right lower bound for them.
 */
const getAttendanceMonthStart = (now = new Date()) => {
  const { year, month } = getIstYearMonth(now);
  return new Date(Date.UTC(year, month, 1));
};

/** Combines the Payout and BulkPayout aggregate results into one rounded total. */
const sumMonthSalary = (payoutAgg, bulkAgg) => {
  const part = (agg) => Number(agg?.[0]?.total) || 0;
  return Math.round((part(payoutAgg) + part(bulkAgg)) * 100) / 100;
};

module.exports = {
  buildDashboardResponse,
  IST_OFFSET_MS,
  getAttendanceMonthStart,
  getMonthBounds,
  sumMonthSalary,
};
