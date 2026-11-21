const assert = require("node:assert/strict");
const { calculateAdvanceStatus, validateNetSalary } = require("../src/utils/payroll");
const {
  buildPayoutHistoryByEmployee,
  filterPayoutsEndingBy,
  findOverlappingPayout,
} = require("../src/utils/payoutOverlap");

// 1. Net salary below zero is rejected (same rule and message as bulk payouts).
const negative = validateNetSalary(1000, 400, 700, "Aakib");
assert.equal(negative.valid, false, "deductions above gross are rejected");
assert.equal(negative.netSalary, -100);
assert.equal(negative.message, "Aakib has deductions greater than gross salary.");

const zero = validateNetSalary(1000, 400, 600, "Aakib");
assert.equal(zero.valid, true, "net salary of exactly zero is allowed");
assert.equal(zero.netSalary, 0);

const rounded = validateNetSalary(100.1, 0.05, 0.05, "Aakib");
assert.equal(rounded.valid, true);
assert.equal(rounded.netSalary, 100);

assert.equal(validateNetSalary(0, 0, 1).message, "Employee has deductions greater than gross salary.");

// 2. Outstanding advance subtracts recoveries from BOTH single and bulk payouts.
const employeeId = "64b000000000000000000001";
const otherEmployeeId = "64b000000000000000000002";
const attendance = [
  { advancePayment: 600 },
  { advancePayment: 400 },
  { advancePayment: 0 },
];

const singlePayout = {
  _id: "single-1",
  employee: employeeId,
  startDate: new Date("2026-10-01T00:00:00.000Z"),
  endDate: new Date("2026-10-10T00:00:00.000Z"),
  advanceDeducted: 300,
};
const bulkPayout = {
  _id: "bulk-1",
  payoutNumber: "NCH-BULK-2026-0001",
  startDate: new Date("2026-10-11T00:00:00.000Z"),
  endDate: new Date("2026-10-20T00:00:00.000Z"),
  employees: [
    { employee: employeeId, advanceDeducted: 200 },
    { employee: otherEmployeeId, advanceDeducted: 999 },
  ],
};
const laterPayout = {
  _id: "single-later",
  employee: employeeId,
  startDate: new Date("2026-11-11T00:00:00.000Z"),
  endDate: new Date("2026-11-20T00:00:00.000Z"),
  advanceDeducted: 50,
};

const history =
  buildPayoutHistoryByEmployee([singlePayout, laterPayout], [bulkPayout]).get(employeeId) || [];
const rangeEnd = new Date("2026-11-10T00:00:00.000Z");
const status = calculateAdvanceStatus(attendance, filterPayoutsEndingBy(history, rangeEnd));

assert.equal(status.totalAdvanceTaken, 1000);
assert.equal(status.advanceRecovered, 500, "single (300) + bulk line (200); other employee and later payout ignored");
assert.equal(status.remainingAdvance, 500);

// Before the fix single payouts only saw Payout records: remaining would wrongly be 700.
const singleOnly = calculateAdvanceStatus(
  attendance,
  filterPayoutsEndingBy(buildPayoutHistoryByEmployee([singlePayout], []).get(employeeId), rangeEnd)
);
assert.equal(singleOnly.remainingAdvance, 700, "control: ignoring bulk lines overstates the advance");

// Recovery can never push the balance below zero.
assert.equal(
  calculateAdvanceStatus([{ advancePayment: 100 }], [{ advanceDeducted: 250 }]).remainingAdvance,
  0
);

// 3. Single payout overlap now sees bulk payout lines.
assert.ok(
  findOverlappingPayout(
    history,
    new Date("2026-10-15T00:00:00.000Z"),
    new Date("2026-10-25T00:00:00.000Z")
  ),
  "a single payout inside a bulk period is detected as overlapping"
);
assert.equal(
  findOverlappingPayout(
    history,
    new Date("2026-10-21T00:00:00.000Z"),
    new Date("2026-10-31T00:00:00.000Z")
  ),
  undefined,
  "an adjacent period does not overlap"
);

console.log("Single payout safety helpers passed.");
