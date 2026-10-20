const assert = require("node:assert/strict");
const {
  buildPayoutHistoryByEmployee,
  findOverlappingPayout,
  getOverlapDetails,
} = require("../src/utils/payoutOverlap");

const employeeId = "employee-aakib";
const requestedStart = new Date("2026-10-11T00:00:00.000Z");
const requestedEnd = new Date("2026-10-20T00:00:00.000Z");

const legacyPayout = {
  _id: "legacy-payout-1",
  employee: employeeId,
  startDate: new Date("2026-10-01T00:00:00.000Z"),
  endDate: new Date("2026-10-10T00:00:00.000Z"),
  paidOn: new Date("2026-10-10T00:00:00.000Z"),
};

const bulkPayout = {
  _id: "bulk-payout-1",
  payoutNumber: "NCH-BULK-2026-0001",
  startDate: new Date("2026-10-11T00:00:00.000Z"),
  endDate: new Date("2026-10-20T00:00:00.000Z"),
  paidOn: new Date("2026-10-20T00:00:00.000Z"),
  employees: [{ employee: employeeId, netSalary: 6000 }],
};

const legacyHistory = buildPayoutHistoryByEmployee([legacyPayout], []);
const legacyBoundaryOverlap = findOverlappingPayout(
  legacyHistory.get(employeeId),
  new Date("2026-10-10T00:00:00.000Z"),
  new Date("2026-10-15T00:00:00.000Z")
);
assert.ok(legacyBoundaryOverlap);
assert.equal(getOverlapDetails(legacyBoundaryOverlap).sourceType, "single");

const bulkHistory = buildPayoutHistoryByEmployee([], [bulkPayout]);
const bulkOverlap = findOverlappingPayout(bulkHistory.get(employeeId), requestedStart, requestedEnd);
assert.ok(bulkOverlap);
assert.deepEqual(getOverlapDetails(bulkOverlap), {
  sourceType: "bulk",
  sourceLabel: "Bulk Payout #NCH-BULK-2026-0001",
  startDate: bulkPayout.startDate,
  endDate: bulkPayout.endDate,
  paidOn: bulkPayout.paidOn,
  parentBulkPayout: {
    id: "bulk-payout-1",
    payoutNumber: "NCH-BULK-2026-0001",
  },
});

const noOverlap = findOverlappingPayout(
  bulkHistory.get(employeeId),
  new Date("2026-10-21T00:00:00.000Z"),
  new Date("2026-10-31T00:00:00.000Z")
);
assert.equal(noOverlap, undefined);

const combinedHistory = buildPayoutHistoryByEmployee([legacyPayout], [bulkPayout]);
assert.ok(findOverlappingPayout(combinedHistory.get(employeeId), requestedStart, requestedEnd));

console.log("Payout overlap lookup passed.");
