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

module.exports = {
  STANDARD_WORK_HOURS,
  calculateNetSalary,
  getWorkingTime,
  isPresentByWorkHours,
  normalizeWorkHours,
  toFiniteNumber,
};
