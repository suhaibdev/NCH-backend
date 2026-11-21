const assert = require("assert");
const { buildManufacturingHistoryQuery, parseSizeKey } = require("./manufacturingHistory");

const productId = "507f1f77bcf86cd799439013";
const sameDate = buildManufacturingHistoryQuery({
  fromDate: "2026-10-14",
  toDate: "2026-10-14",
});

assert.equal(sameDate.valid, true, "same From and To Date are valid");
assert.equal(
  sameDate.value.filters.manufacturingDate.$gte.toISOString(),
  "2026-10-14T00:00:00.000Z",
  "date filtering starts at the Manufacturing Date in UTC"
);
assert.equal(
  sameDate.value.filters.manufacturingDate.$lt.toISOString(),
  "2026-10-15T00:00:00.000Z",
  "same-date filtering ends before the following business date"
);

const combined = buildManufacturingHistoryQuery({
  page: "2",
  limit: "25",
  month: "2026-10",
  fromDate: "2026-10-14",
  toDate: "2026-10-20",
  finishedItem: productId,
  size: "18|m|40|inch",
  batchNumber: "B-00",
});

assert.equal(combined.valid, true, "month, dates, product, size and batch filters combine");
assert.equal(combined.value.page, 2, "history pagination accepts bounded pages");
assert.equal(combined.value.limit, 25, "history pagination accepts bounded limits");
assert.equal(combined.value.filters.finishedItem.toString(), productId, "product filter is server-side");
assert.equal(combined.value.filters.normalizedBatchNumber.$regex, "b-00", "batch search is partial");
assert.deepEqual(combined.value.filters.materials.$elemMatch, {
  "size.lengthValue": 18,
  "size.lengthUnit": "m",
  "size.widthValue": 40,
  "size.widthUnit": "inch",
});
assert.equal(parseSizeKey("bad-size").valid, false, "invalid sizes are rejected");
assert.equal(
  buildManufacturingHistoryQuery({ fromDate: "2026-10-20", toDate: "2026-10-14" }).valid,
  false,
  "reversed date ranges are rejected"
);
assert.equal(
  buildManufacturingHistoryQuery({ month: "2026-13" }).valid,
  false,
  "invalid month filters are rejected"
);

const special = buildManufacturingHistoryQuery({ batchNumber: "a.b(" });
assert.equal(special.valid, true, "batch search with regex characters is accepted");
const specialFilter = special.value.filters.normalizedBatchNumber;
assert.equal(specialFilter.$regex, "a\\.b\\(", "batch search escapes regex characters");
assert.equal(specialFilter.$options, "i", "batch search is case-insensitive");
let specialRegex;
assert.doesNotThrow(() => {
  specialRegex = new RegExp(specialFilter.$regex, specialFilter.$options);
}, "escaped batch search compiles");
assert.equal(specialRegex.test("xa.b(y"), true, "escaped batch search matches literally");
assert.equal(specialRegex.test("axb("), false, "escaped '.' does not match any character");

console.log("Manufacturing history helper tests passed.");
