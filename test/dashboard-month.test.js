/* Pure tests for the dashboard IST month bounds and month-salary sum (no DB). */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("path");
const {
  getAttendanceMonthStart,
  getMonthBounds,
  sumMonthSalary,
} = require("../src/utils/dashboardResponse");

const iso = (bounds) => [bounds.start.toISOString(), bounds.end.toISOString()];

// IST months: bounds are IST midnight (18:30Z the evening before), [start, end).
const october = ["2025-09-30T18:30:00.000Z", "2025-10-31T18:30:00.000Z"];
assert.deepEqual(iso(getMonthBounds(new Date("2025-10-15T12:00:00.000Z"))), october);
assert.deepEqual(iso(getMonthBounds(new Date("2025-09-30T18:30:00.000Z"))), october, "first IST instant");
assert.deepEqual(iso(getMonthBounds(new Date("2025-10-31T18:29:59.999Z"))), october, "last IST millisecond");

// 1st-of-month boundary: 18:30Z on the last UTC day is already the 1st in IST.
const november = ["2025-10-31T18:30:00.000Z", "2025-11-30T18:30:00.000Z"];
assert.deepEqual(iso(getMonthBounds(new Date("2025-10-31T18:30:00.000Z"))), november);
assert.deepEqual(iso(getMonthBounds(new Date("2025-11-01T00:00:00.000Z"))), november, "UTC 1st midnight is still November");
assert.deepEqual(iso(getMonthBounds(new Date("2026-11-30T18:29:59.999Z"))), [
  "2026-10-31T18:30:00.000Z",
  "2026-11-30T18:30:00.000Z",
]);
assert.deepEqual(iso(getMonthBounds(new Date("2026-11-30T18:30:00.000Z"))), [
  "2026-11-30T18:30:00.000Z",
  "2026-12-31T18:30:00.000Z",
]);

// A payout paid at 00:30 IST on 1 December counts for December, not November.
const paid = new Date("2026-11-30T19:00:00.000Z");
const december = getMonthBounds(paid);
assert.ok(paid >= december.start && paid < december.end);
const novemberBounds = getMonthBounds(new Date("2026-11-15T00:00:00.000Z"));
assert.ok(!(paid >= novemberBounds.start && paid < novemberBounds.end));

// December rolls into January; leap February rolls into March at IST midnight.
assert.deepEqual(iso(getMonthBounds(new Date("2025-12-20T00:00:00.000Z"))), [
  "2025-11-30T18:30:00.000Z",
  "2025-12-31T18:30:00.000Z",
]);
assert.deepEqual(iso(getMonthBounds(new Date("2025-12-31T18:30:00.000Z"))), [
  "2025-12-31T18:30:00.000Z",
  "2026-01-31T18:30:00.000Z",
]);
assert.deepEqual(iso(getMonthBounds(new Date("2024-02-29T18:29:59.999Z"))), [
  "2024-01-31T18:30:00.000Z",
  "2024-02-29T18:30:00.000Z",
]);
assert.deepEqual(iso(getMonthBounds(new Date("2024-02-29T18:30:00.000Z"))), [
  "2024-02-29T18:30:00.000Z",
  "2024-03-31T18:30:00.000Z",
]);

// Attendance month start: UTC midnight of the IST month's 1st.
assert.equal(
  getAttendanceMonthStart(new Date("2026-11-30T18:29:59.999Z")).toISOString(),
  "2026-11-01T00:00:00.000Z"
);
assert.equal(
  getAttendanceMonthStart(new Date("2026-11-30T18:30:00.000Z")).toISOString(),
  "2026-12-01T00:00:00.000Z"
);

// Result does not depend on the server time zone.
const script = `
  const { getMonthBounds } = require(${JSON.stringify(path.join(__dirname, "../src/utils/dashboardResponse"))});
  const b = getMonthBounds(new Date("2025-10-31T20:00:00.000Z"));
  console.log(b.start.toISOString() + "|" + b.end.toISOString());
`;
const outputs = ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"].map((TZ) =>
  execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ } }).toString().trim()
);
assert.equal(new Set(outputs).size, 1, "bounds are the same in every time zone");
assert.equal(outputs[0], november.join("|"));

// sumMonthSalary.
assert.equal(sumMonthSalary([], []), 0);
assert.equal(sumMonthSalary(undefined, undefined), 0);
assert.equal(sumMonthSalary([{ _id: null, total: 1500 }], []), 1500);
assert.equal(sumMonthSalary([], [{ _id: null, total: 2500.5 }]), 2500.5);
assert.equal(sumMonthSalary([{ total: 1500 }], [{ total: 2500.5 }]), 4000.5);
assert.equal(sumMonthSalary([{ total: 0.1 }], [{ total: 0.2 }]), 0.3, "floating point noise is rounded");
assert.equal(sumMonthSalary([{ total: null }], [{ total: "abc" }]), 0, "bad totals count as zero");

console.log("Dashboard month salary: all assertions passed.");
