const STANDARD_WORK_HOURS = 8;

const toFiniteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const normalizeWorkHours = (value) => Math.max(0, toFiniteNumber(value));

/** Work hours are the authoritative attendance status. */
const isPresentByWorkHours = (value) => normalizeWorkHours(value) > 0;

/** Express accumulated time using the factory's eight-hour working day. */
const getWorkingTime = (value) => {
  const totalHours = Number(normalizeWorkHours(value).toFixed(10));
  const fullWorkingDays = Math.floor(totalHours / STANDARD_WORK_HOURS);
  const remainingWorkingHours = Number(
    (totalHours - fullWorkingDays * STANDARD_WORK_HOURS).toFixed(10)
  );

  return {
    totalHours,
    fullWorkingDays,
    remainingWorkingHours,
    display: `${fullWorkingDays}D ${remainingWorkingHours}H`,
  };
};

const calculateNetSalary = (grossSalary, advanceDeducted, otherDeduction) =>
  Math.round(
    (toFiniteNumber(grossSalary) -
      toFiniteNumber(advanceDeducted) -
      toFiniteNumber(otherDeduction)) * 100
  ) / 100;

const roundCurrency = (value) => Math.round(value * 100) / 100;

/**
 * Lifetime advance status for an employee.
 * `payoutRecords` may mix single Payout records and BulkPayout employee
 * lines (see buildPayoutHistoryByEmployee) so recoveries are never counted twice.
 */
const calculateAdvanceStatus = (attendanceRecords, payoutRecords) => {
  const totalAdvanceTaken = roundCurrency(attendanceRecords.reduce(
    (sum, item) => sum + (item.advancePayment || 0),
    0
  ));

  const advanceRecovered = roundCurrency(payoutRecords.reduce(
    (sum, item) => sum + (item.advanceDeducted || 0),
    0
  ));

  return {
    totalAdvanceTaken,
    advanceRecovered,
    remainingAdvance: roundCurrency(Math.max(0, totalAdvanceTaken - advanceRecovered)),
  };
};

/** Net salary must not go below zero (same rule as bulk payouts). */
const validateNetSalary = (grossSalary, advanceDeducted, otherDeduction, employeeName) => {
  const netSalary = calculateNetSalary(grossSalary, advanceDeducted, otherDeduction);
  if (netSalary < 0) {
    return {
      valid: false,
      netSalary,
      message: `${employeeName || "Employee"} has deductions greater than gross salary.`,
    };
  }
  return { valid: true, netSalary };
};

module.exports = {
  STANDARD_WORK_HOURS,
  calculateAdvanceStatus,
  calculateNetSalary,
  validateNetSalary,
  getWorkingTime,
  isPresentByWorkHours,
  normalizeWorkHours,
  toFiniteNumber,
};
