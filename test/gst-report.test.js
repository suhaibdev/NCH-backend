/*
 * GST report helpers (no DB): period bounds (months, 31 Mar / 1 Apr, FY,
 * custom range limits), paise-to-rupee formatting, CSV escaping and
 * formula-injection protection, HSN tax apportionment, reconciliation.
 */
const assert = require("node:assert/strict");
const { computeInvoiceTax } = require("../src/utils/gstInvoice");
const {
  CSV_MAX_INVOICES,
  MAX_RANGE_DAYS,
  apportionTax,
  buildCsv,
  escapeCsvCell,
  formatPaiseAsRupees,
  parseReportPeriod,
  periodSlug,
  publicPeriod,
  reconciles,
  splitByWeight,
  sumTotals,
} = require("../src/utils/gstReport");

const TODAY = "2027-06-15";
const period = (query) => {
  const result = parseReportPeriod(query, TODAY);
  assert.equal(result.valid, true, result.message);
  return result.value;
};
const bounds = (query) => {
  const value = period(query);
  return [value.from.toISOString(), value.toExclusive.toISOString(), value.fromKey, value.toKey];
};

/* ---------- month bounds ---------- */
assert.deepEqual(bounds({ month: "2026-11" }), [
  "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", "2026-11-01", "2026-11-30",
], "30-day month");
assert.deepEqual(bounds({ month: "2026-12" }).slice(1), ["2027-01-01T00:00:00.000Z", "2026-12-01", "2026-12-31"], "December into January");
assert.equal(bounds({ month: "2027-01" })[3], "2027-01-31", "31-day month");
assert.equal(bounds({ month: "2027-02" })[3], "2027-02-28", "February, non-leap");
assert.equal(bounds({ month: "2024-02" })[3], "2024-02-29", "February, leap year");
assert.equal(bounds({ month: "2027-03" })[3], "2027-03-31", "31 March closes the month and the FY");
assert.equal(bounds({ month: "2027-04" })[2], "2027-04-01", "1 April opens the month");
assert.equal(period({ month: "2026-11" }).label, "November 2026");
assert.equal(period({}).fromKey, "2027-06-01", "default: the current IST month");
assert.equal(period({}).mode, "month");

/* ---------- financial year bounds ---------- */
assert.deepEqual(bounds({ fy: "2026-27" }), [
  "2026-04-01T00:00:00.000Z", "2027-04-01T00:00:00.000Z", "2026-04-01", "2027-03-31",
]);
assert.equal(period({ fy: "2026-27" }).label, "FY 2026-27");
assert.equal(parseReportPeriod({ fy: "2099-00" }, "2100-01-01").valid, true, "century wrap 2099-00 is well formed");
assert.equal(parseReportPeriod({ fy: "2099-00" }, TODAY).valid, false, "but rejected while in the future");

/* ---------- custom range ---------- */
assert.deepEqual(bounds({ from: "2026-11-05", to: "2026-11-05" }), [
  "2026-11-05T00:00:00.000Z", "2026-11-06T00:00:00.000Z", "2026-11-05", "2026-11-05",
], "a one-day range, inclusive end");
assert.equal(period({ from: "2026-03-31", to: "2026-04-01" }).toExclusive.toISOString(), "2026-04-02T00:00:00.000Z");
assert.equal(MAX_RANGE_DAYS, 366);
assert.equal(parseReportPeriod({ from: "2024-01-01", to: "2024-12-31" }, TODAY).valid, true, "366 days (leap year) allowed");
assert.equal(parseReportPeriod({ from: "2025-06-01", to: "2026-06-02" }, TODAY).valid, false, "367 days rejected");
assert.equal(period({ from: "2026-11-01", to: "2026-11-30" }).label, "01/11/2026 to 30/11/2026");

/* ---------- invalid periods ---------- */
[
  { month: "2026-13" },
  { month: "2026-00" },
  { month: "2026-1" },
  { month: "nov" },
  { fy: "2026-28" },
  { fy: "2026" },
  { from: "2026-11-30", to: "2026-11-01" },
  { from: "2026-11-01" },
  { from: "2026-02-30", to: "2026-03-01" },
  { month: "2026-11", fy: "2026-27" },
  { month: "2026-11", from: "2026-11-01", to: "2026-11-02" },
  { month: "2027-07" },
  { fy: "2028-29" },
  { from: "2027-06-01", to: "2027-06-16" },
].forEach((query) => assert.equal(parseReportPeriod(query, TODAY).valid, false, JSON.stringify(query)));
assert.equal(parseReportPeriod({ month: "2027-06" }, TODAY).valid, true, "the current month is allowed");

assert.deepEqual(publicPeriod(period({ month: "2026-11" })), {
  mode: "month",
  from: "2026-11-01",
  to: "2026-11-30",
  label: "November 2026",
});
assert.equal(periodSlug(period({ month: "2026-11" })), "2026-11");
assert.equal(periodSlug(period({ fy: "2026-27" })), "FY2026-27");
assert.equal(periodSlug(period({ from: "2026-11-01", to: "2026-11-15" })), "2026-11-01_to_2026-11-15");

/* ---------- paise to rupees, no float error ---------- */
assert.equal(formatPaiseAsRupees(0), "0.00");
assert.equal(formatPaiseAsRupees(1), "0.01");
assert.equal(formatPaiseAsRupees(10), "0.10");
assert.equal(formatPaiseAsRupees(99), "0.99");
assert.equal(formatPaiseAsRupees(100), "1.00");
assert.equal(formatPaiseAsRupees(12550), "125.50");
assert.equal(formatPaiseAsRupees(-26), "-0.26");
assert.equal(formatPaiseAsRupees(-50), "-0.50");
assert.equal(formatPaiseAsRupees(29), "0.29", "0.29 is not 0.28999...");
assert.equal(formatPaiseAsRupees(1000000000057), "10000000000.57");
assert.equal(formatPaiseAsRupees(Number.MAX_SAFE_INTEGER), "90071992547409.91");
assert.throws(() => formatPaiseAsRupees(1.5));
assert.throws(() => formatPaiseAsRupees("100"));

/* ---------- CSV escaping and formula injection ---------- */
assert.equal(escapeCsvCell("Shree Medicals"), "Shree Medicals");
assert.equal(escapeCsvCell("Shree, Lucknow"), '"Shree, Lucknow"');
assert.equal(escapeCsvCell('The "Best" Store'), '"The ""Best"" Store"');
assert.equal(escapeCsvCell("Line1\nLine2"), '"Line1\nLine2"');
assert.equal(escapeCsvCell("Line1\r\nLine2"), '"Line1\r\nLine2"');
assert.equal(escapeCsvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)", "leading = is neutralised");
assert.equal(escapeCsvCell("+91 98765"), "'+91 98765");
assert.equal(escapeCsvCell("-Ramesh"), "'-Ramesh");
assert.equal(escapeCsvCell("@cmd"), "'@cmd");
assert.equal(escapeCsvCell("\tTabbed"), "'\tTabbed");
assert.equal(escapeCsvCell("\rReturn"), "\"'\rReturn\"", "prefixed, then quoted for the CR");
assert.equal(escapeCsvCell('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
assert.equal(escapeCsvCell("A=B"), "A=B", "only a LEADING = is dangerous");
assert.equal(escapeCsvCell("-0.26", { numeric: true }), "-0.26", "our negative amounts stay numeric");
assert.equal(escapeCsvCell("125.50", { numeric: true }), "125.50");
assert.equal(escapeCsvCell("-=1", { numeric: true }), "'-=1", "a numeric flag never protects non-numbers");
assert.equal(escapeCsvCell(undefined), "");
assert.equal(escapeCsvCell(null), "");
assert.equal(escapeCsvCell(42), "42");

const csv = buildCsv([
  ["Customer", "Total"],
  ["=evil", { value: "-0.26", numeric: true }],
  ["A, B", { value: "1.00", numeric: true }],
]);
assert.ok(csv.startsWith("﻿"), "UTF-8 BOM for Excel");
assert.equal(csv, "﻿Customer,Total\r\n'=evil,-0.26\r\n\"A, B\",1.00\r\n", "CRLF line endings");

/* ---------- HSN tax apportionment ---------- */
assert.deepEqual(splitByWeight(100, [1, 1, 1]), [34, 33, 33]);
assert.deepEqual(splitByWeight(0, [5, 5]), [0, 0]);
assert.deepEqual(splitByWeight(7, [0, 0]), [7, 0], "nothing to weigh by");
assert.deepEqual(splitByWeight(5, []), []);
assert.equal(splitByWeight(Number.MAX_SAFE_INTEGER, [3, 7]).reduce((a, b) => a + b, 0), Number.MAX_SAFE_INTEGER, "BigInt, no overflow");

let seed = 11;
const random = (max) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % max;
};
const RATES = [0, 0.25, 3, 5, 18, 40];
const HSNS = ["3005", "30059040", "6307", "5208"];

for (let run = 0; run < 300; run += 1) {
  const rateRows = [];
  const hsnRows = [];
  RATES.forEach((rate) => {
    if (random(2) === 0) return;
    const rows = HSNS.slice(0, 1 + random(4)).map((hsnCode) => ({
      hsnCode,
      gstRatePercent: rate,
      unit: random(2) ? "pcs" : "dozen",
      quantity: 1 + random(100),
      taxablePaise: random(5000000),
    }));
    hsnRows.push(...rows);
    rateRows.push({
      gstRatePercent: rate,
      cgstPaise: random(200000),
      sgstPaise: random(200000),
      igstPaise: random(400000),
    });
  });
  const items = apportionTax(rateRows, hsnRows);
  assert.equal(items.length, hsnRows.length);
  rateRows.forEach((rate) => {
    const rows = items.filter((row) => row.gstRatePercent === rate.gstRatePercent);
    ["cgstPaise", "sgstPaise", "igstPaise"].forEach((field) =>
      assert.equal(rows.reduce((sum, row) => sum + row[field], 0), rate[field], `run ${run} ${field} sums exactly`)
    );
    rows.forEach((row) => {
      assert.ok(Number.isSafeInteger(row.cgstPaise) && row.cgstPaise >= 0);
      assert.equal(row.taxPaise, row.cgstPaise + row.sgstPaise + row.igstPaise);
    });
  });
}

/* ---------- reconciliation on random invoice sets ---------- */
const randomInvoice = () => {
  const lines = Array.from({ length: 1 + random(5) }, () => ({
    gstRatePercent: RATES[random(RATES.length)],
    taxablePaise: (1 + random(400)) * (1 + random(300000)),
  }));
  return computeInvoiceTax(lines, random(2) ? "intra" : "inter");
};
for (let run = 0; run < 500; run += 1) {
  const invoices = Array.from({ length: 1 + random(40) }, randomInvoice);
  invoices.forEach((invoice) => assert.ok(reconciles(invoice), "each invoice reconciles"));
  const totals = sumTotals(invoices);
  assert.equal(totals.invoiceCount, invoices.length);
  assert.ok(reconciles(totals), `run ${run}: totals reconcile to the paisa`);
}
assert.equal(reconciles({ taxablePaise: 100, cgstPaise: 3, sgstPaise: 3, igstPaise: 0, roundOffPaise: -6, totalPaise: 100 }), true);
assert.equal(reconciles({ taxablePaise: 100, cgstPaise: 3, sgstPaise: 3, igstPaise: 0, roundOffPaise: -6, totalPaise: 101 }), false, "a one-paisa mismatch is caught");

assert.equal(CSV_MAX_INVOICES, 5000);

console.log("GST report helpers: all assertions passed.");
