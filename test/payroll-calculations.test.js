const assert = require('node:assert/strict');
const {
  calculateNetSalary,
  getWorkingTime,
  isPresentByWorkHours,
} = require('../src/utils/payroll');

const cases = [
  [1, { fullWorkingDays: 0, remainingWorkingHours: 1, display: '0D 1H' }],
  [7, { fullWorkingDays: 0, remainingWorkingHours: 7, display: '0D 7H' }],
  [8, { fullWorkingDays: 1, remainingWorkingHours: 0, display: '1D 0H' }],
  [9, { fullWorkingDays: 1, remainingWorkingHours: 1, display: '1D 1H' }],
  [16, { fullWorkingDays: 2, remainingWorkingHours: 0, display: '2D 0H' }],
  [20, { fullWorkingDays: 2, remainingWorkingHours: 4, display: '2D 4H' }],
];

cases.forEach(([hours, expected]) => {
  const actual = getWorkingTime(hours);
  assert.deepEqual(
    {
      fullWorkingDays: actual.fullWorkingDays,
      remainingWorkingHours: actual.remainingWorkingHours,
      display: actual.display,
    },
    expected
  );
});

assert.equal(isPresentByWorkHours(0), false);
assert.equal(isPresentByWorkHours(0.5), true);
assert.equal(calculateNetSalary(100, 120, 5), -25);

console.log('Payroll calculations passed.');
