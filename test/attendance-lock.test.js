const assert = require("node:assert/strict");
const { startOfDay } = require("date-fns");
const {
  findCoveringPayouts,
  payoutCoversDay,
  toAttendanceDayKey,
  toPayoutDayKey,
} = require("../src/utils/payoutOverlap");

// Attendance is always stored at UTC midnight of its business date.
const attendanceAt = (day) => new Date(`${day}T00:00:00.000Z`);
const dayKey = (day) => toAttendanceDayKey(attendanceAt(day));

const assertCoverage = (payout, label) => {
  assert.equal(payoutCoversDay(payout, dayKey("2026-10-31")), false, `${label}: day before start`);
  assert.equal(payoutCoversDay(payout, dayKey("2026-11-01")), true, `${label}: start day`);
  assert.equal(payoutCoversDay(payout, dayKey("2026-11-05")), true, `${label}: middle day`);
  assert.equal(payoutCoversDay(payout, dayKey("2026-11-10")), true, `${label}: end day`);
  assert.equal(payoutCoversDay(payout, dayKey("2026-11-11")), false, `${label}: day after end`);
};

// 1. Single payout: raw "YYYY-MM-DD" strings saved by Mongoose as UTC midnight.
assertCoverage(
  { startDate: new Date("2026-11-01"), endDate: new Date("2026-11-10") },
  "single payout (UTC midnight)"
);

// 2. Bulk payouts saved as server-local midnight, simulated with explicit instants.
assertCoverage(
  {
    startDate: new Date("2026-10-31T18:30:00.000Z"),
    endDate: new Date("2026-11-09T18:30:00.000Z"),
  },
  "bulk payout on IST server (UTC+05:30)"
);
assertCoverage(
  {
    startDate: new Date("2026-10-31T05:00:00.000Z"),
    endDate: new Date("2026-11-09T05:00:00.000Z"),
  },
  "bulk payout on New York server (UTC-05:00)"
);
assertCoverage(
  {
    startDate: new Date("2026-10-31T11:00:00.000Z"),
    endDate: new Date("2026-11-09T11:00:00.000Z"),
  },
  "bulk payout on Auckland server (UTC+13:00)"
);
assertCoverage(
  {
    startDate: new Date("2026-11-01T00:00:00.000Z"),
    endDate: new Date("2026-11-10T00:00:00.000Z"),
  },
  "bulk payout on UTC server"
);

// 3. Bulk bounds built exactly like the bulk route does, in THIS process's time zone.
//    Run with TZ=UTC, TZ=Asia/Kolkata, TZ=America/New_York to cover several zones.
assertCoverage(
  {
    startDate: startOfDay(new Date("2026-11-01")),
    endDate: startOfDay(new Date("2026-11-10")),
  },
  `bulk payout via startOfDay (offset ${-new Date("2026-11-01").getTimezoneOffset()} min)`
);

assert.equal(toPayoutDayKey(new Date("2026-11-01T00:00:00.000Z")), "2026-11-01");
assert.equal(toPayoutDayKey("not a date"), null);
assert.equal(toAttendanceDayKey("not a date"), null);
assert.equal(payoutCoversDay({ startDate: null, endDate: null }, "2026-11-01"), false);

// 4. Lock lookup across single and bulk payouts.
const aakib = "64b000000000000000000001";
const bilal = "64b000000000000000000002";
const chand = "64b000000000000000000003";

const singlePayout = {
  _id: "single-1",
  employee: aakib,
  startDate: new Date("2026-11-01"),
  endDate: new Date("2026-11-10"),
  salarySlipNumber: "NCH-PAY-2026-0007",
};
const bulkPayout = {
  _id: "bulk-1",
  payoutNumber: "NCH-BULK-2026-0003",
  startDate: new Date("2026-10-31T18:30:00.000Z"),
  endDate: new Date("2026-11-09T18:30:00.000Z"),
  employees: [{ employee: bilal, employeeName: "Bilal" }],
};

const lockedOnFifth = findCoveringPayouts(
  [singlePayout],
  [bulkPayout],
  [aakib, bilal, chand, aakib],
  dayKey("2026-11-05")
);
assert.equal(lockedOnFifth.length, 2, "only employees covered by a payout are locked, once each");

const aakibLock = lockedOnFifth.find((item) => item.employeeId === aakib);
assert.equal(aakibLock.sourceType, "single");
assert.equal(aakibLock.payoutNumber, "NCH-PAY-2026-0007");
assert.equal(aakibLock.payoutId, "single-1");

const bilalLock = lockedOnFifth.find((item) => item.employeeId === bilal);
assert.equal(bilalLock.sourceType, "bulk");
assert.equal(bilalLock.payoutNumber, "NCH-BULK-2026-0003");
assert.equal(bilalLock.payoutId, "bulk-1");
assert.equal(bilalLock.employeeName, "Bilal");

assert.equal(
  lockedOnFifth.some((item) => item.employeeId === chand),
  false,
  "employee outside the bulk payout is not locked"
);
assert.deepEqual(
  findCoveringPayouts([singlePayout], [bulkPayout], [aakib, bilal], dayKey("2026-11-11")),
  [],
  "day after both payouts is unlocked"
);
assert.deepEqual(
  findCoveringPayouts([], [], [aakib], dayKey("2026-11-05")),
  [],
  "deleting the payout (no records) unlocks attendance"
);

console.log(
  `Attendance lock helpers passed (TZ offset ${-new Date("2026-11-01").getTimezoneOffset()} min).`
);
