/* Pure tests for the dashboard month bounds and month-salary sum (no DB). */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("path");
const { getMonthBounds, sumMonthSalary } = require("../src/utils/dashboardResponse");

const iso = (bounds) => [bounds.start.toISOString(), bounds.end.toISOString()];

// Mid-month, first instant and last millisecond all map to the same month.
const october = ["2025-10-01T00:00:00.000Z", "2025-11-01T00:00:00.000Z"];
assert.deepEqual(iso(getMonthBounds(new Date("2025-10-15T12:00:00.000Z"))), october);
assert.deepEqual(iso(getMonthBounds(new Date("2025-10-01T00:00:00.000Z"))), october);
assert.deepEqual(iso(getMonthBounds(new Date("2025-10-31T23:59:59.999Z"))), october);
// The next instant belongs to November.
assert.deepEqual(iso(getMonthBounds(new Date("2025-11-01T00:00:00.000Z"))), [
  "2025-11-01T00:00:00.000Z",
  "2025-12-01T00:00:00.000Z",
]);
// December rolls into January of the next year; February honours leap years.
assert.deepEqual(iso(getMonthBounds(new Date("2025-12-20T00:00:00.000Z"))), [
  "2025-12-01T00:00:00.000Z",
  "2026-01-01T00:00:00.000Z",
]);
assert.deepEqual(iso(getMonthBounds(new Date("2024-02-10T00:00:00.000Z"))), [
  "2024-02-01T00:00:00.000Z",
  "2024-03-01T00:00:00.000Z",
]);

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
assert.equal(outputs[0], october.join("|"));

// sumMonthSalary.
assert.equal(sumMonthSalary([], []), 0);
assert.equal(sumMonthSalary(undefined, undefined), 0);
assert.equal(sumMonthSalary([{ _id: null, total: 1500 }], []), 1500);
assert.equal(sumMonthSalary([], [{ _id: null, total: 2500.5 }]), 2500.5);
assert.equal(sumMonthSalary([{ total: 1500 }], [{ total: 2500.5 }]), 4000.5);
assert.equal(sumMonthSalary([{ total: 0.1 }], [{ total: 0.2 }]), 0.3, "floating point noise is rounded");
assert.equal(sumMonthSalary([{ total: null }], [{ total: "abc" }]), 0, "bad totals count as zero");

console.log("Dashboard month salary: all assertions passed.");
