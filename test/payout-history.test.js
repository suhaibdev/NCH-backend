const assert = require("node:assert/strict");
const { getHistoryPagination, serializeBulkHistoryItem } = require("../src/utils/payoutHistory");
const { buildPayoutHistoryByEmployee } = require("../src/utils/payoutOverlap");

assert.deepEqual(getHistoryPagination({}), { page: 1, limit: 20 });
assert.deepEqual(getHistoryPagination({ page: "3", limit: "100" }), { page: 3, limit: 20 });
assert.deepEqual(getHistoryPagination({ page: "-1", limit: "0" }), { page: 1, limit: 20 });

const bulk = serializeBulkHistoryItem({
  _id: "bulk-1",
  startDate: new Date("2026-10-11T00:00:00.000Z"),
  endDate: new Date("2026-10-20T00:00:00.000Z"),
  paidOn: new Date("2026-10-20T00:00:00.000Z"),
  employees: [{ employee: "aakib", paymentMethod: "bank" }],
});
assert.equal(bulk.paymentMethod, "bank");
assert.equal(serializeBulkHistoryItem({ employees: [{ paymentMethod: "cash" }, { paymentMethod: "upi" }] }).paymentMethod, "mixed");

const single = { employee: "aakib", startDate: new Date("2026-10-11T00:00:00.000Z"), endDate: new Date("2026-10-20T00:00:00.000Z") };
assert.equal(buildPayoutHistoryByEmployee([single], []).get("aakib")[0].overlapSource, "legacy");
assert.equal(buildPayoutHistoryByEmployee([], [{ _id: "bulk-1", employees: [{ employee: "aakib" }], startDate: bulk.startDate, endDate: bulk.endDate }]).get("aakib")[0].parentBulkPayoutId, "bulk-1");

console.log("Payout history helpers passed.");
