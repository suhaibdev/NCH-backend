/*
 * GST report routes against in-memory invoices (no DB).
 *
 * A small evaluator runs the REAL aggregation pipelines ($match, $facet,
 * $unwind, $group, $sort, $limit and the expressions they use), so the
 * route's filters and sums are actually exercised. Estimate, Challan and
 * payment models are stubbed to record any use: the report must touch only
 * GST invoices. Reversed invoices must never reach any total.
 */
const assert = require("node:assert/strict");
const path = require("path");
const { root, stub } = require("./helpers/sessionFakes");
const { computeInvoiceTax, determineTaxType } = require("../src/utils/gstInvoice");
const { formatPaiseAsRupees, sumTotals } = require("../src/utils/gstReport");

/* ---------- tiny aggregation evaluator ---------- */

const getValues = (doc, dotted) => {
  let values = [doc];
  for (const key of dotted.split(".")) {
    values = values.flatMap((value) => {
      if (value === null || value === undefined) return [undefined];
      const next = value[key];
      return Array.isArray(next) ? next : [next];
    });
  }
  return values;
};
const getPath = (doc, dotted) =>
  dotted.split(".").reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), doc);

const asComparable = (value) => (value instanceof Date ? value.getTime() : value);

const evalExpr = (expr, doc) => {
  if (typeof expr === "string" && expr.startsWith("$")) return getPath(doc, expr.slice(1));
  if (Array.isArray(expr)) return expr.map((entry) => evalExpr(entry, doc));
  if (expr && typeof expr === "object" && !(expr instanceof Date)) {
    const [op] = Object.keys(expr);
    const args = expr[op];
    switch (op) {
      case "$add":
        return args.reduce((sum, arg) => sum + (evalExpr(arg, doc) || 0), 0);
      case "$ne":
        return evalExpr(args[0], doc) !== evalExpr(args[1], doc);
      case "$gt":
        return evalExpr(args[0], doc) > evalExpr(args[1], doc);
      case "$cond":
        return evalExpr(args[0], doc) ? evalExpr(args[1], doc) : evalExpr(args[2], doc);
      case "$strLenCP":
        return String(evalExpr(args, doc)).length;
      case "$ifNull": {
        const value = evalExpr(args[0], doc);
        return value === null || value === undefined ? evalExpr(args[1], doc) : value;
      }
      default:
        if (op.startsWith("$")) throw new Error(`evaluator: unsupported operator ${op}`);
        return Object.fromEntries(Object.entries(expr).map(([key, value]) => [key, evalExpr(value, doc)]));
    }
  }
  return expr;
};

const matchDoc = (doc, filter) =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((sub) => matchDoc(doc, sub));
    const values = getValues(doc, key);
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      return Object.entries(condition).every(([op, operand]) => {
        if (op === "$exists") return values.some((value) => value !== undefined) === operand;
        if (op === "$gte") return values.some((value) => asComparable(value) >= asComparable(operand));
        if (op === "$lt") return values.some((value) => asComparable(value) < asComparable(operand));
        throw new Error(`evaluator: unsupported query operator ${op}`);
      });
    }
    return values.some((value) =>
      condition === null ? value === null || value === undefined : asComparable(value) === asComparable(condition)
    );
  });

const sortDocs = (docs, spec) =>
  [...docs].sort((a, b) => {
    for (const [key, direction] of Object.entries(spec)) {
      const left = asComparable(getPath(a, key));
      const right = asComparable(getPath(b, key));
      if (left < right) return -direction;
      if (left > right) return direction;
    }
    return 0;
  });

const runPipeline = (docs, pipeline) => {
  let current = docs;
  for (const stage of pipeline) {
    const [op] = Object.keys(stage);
    const spec = stage[op];
    if (op === "$match") current = current.filter((doc) => matchDoc(doc, spec));
    else if (op === "$facet") {
      const input = current;
      current = [Object.fromEntries(Object.entries(spec).map(([key, sub]) => [key, runPipeline(input, sub)]))];
    } else if (op === "$unwind") {
      const field = spec.slice(1);
      current = current.flatMap((doc) => (getPath(doc, field) || []).map((entry) => ({ ...doc, [field]: entry })));
    } else if (op === "$group") {
      const groups = new Map();
      for (const doc of current) {
        const id = evalExpr(spec._id, doc);
        const key = JSON.stringify(id);
        if (!groups.has(key)) groups.set(key, { _id: id, __first: {} });
        const group = groups.get(key);
        for (const [field, accumulator] of Object.entries(spec)) {
          if (field === "_id") continue;
          const [accOp] = Object.keys(accumulator);
          const value = evalExpr(accumulator[accOp], doc);
          if (accOp === "$sum") group[field] = (group[field] || 0) + (Number(value) || 0);
          else if (accOp === "$first") {
            if (!(field in group.__first)) group.__first[field] = value;
            group[field] = group.__first[field];
          } else if (accOp === "$last") group[field] = value;
          else throw new Error(`evaluator: unsupported accumulator ${accOp}`);
        }
      }
      current = [...groups.values()].map(({ __first, ...group }) => group);
    } else if (op === "$sort") current = sortDocs(current, spec);
    else if (op === "$limit") current = current.slice(0, spec);
    else throw new Error(`evaluator: unsupported stage ${op}`);
  }
  return current;
};

/* ---------- in-memory invoices ---------- */

const ID = (n) => `64b1000000000000000000${String(n).padStart(2, "0")}`;
let sequence = 0;

const makeInvoice = ({ number, date, status = "active", gstin = "", stateCode = "09", name, lines, reversedAt = null }) => {
  sequence += 1;
  const taxType = determineTaxType(stateCode);
  const savedLines = lines.map(([hsnCode, gstRatePercent, quantity, pricePaise, unit = "pcs"]) => ({
    hsnCode,
    gstRatePercent,
    quantity,
    pricePaise,
    unit,
    taxablePaise: quantity * pricePaise,
  }));
  const tax = computeInvoiceTax(savedLines, taxType);
  return {
    _id: ID(sequence),
    invoiceNumber: number,
    sequence,
    invoiceDate: new Date(`${date}T00:00:00.000Z`),
    status,
    reversedAt: reversedAt ? new Date(reversedAt) : null,
    taxType,
    customerSnapshot: { name: name || `Customer ${number}`, billingName: "", gstin, stateCode },
    lines: savedLines,
    ...tax,
  };
};

const baseInvoices = () => [
  // Inside November 2026 (both edges), active:
  makeInvoice({ number: "INV/2026-27/0101", date: "2026-11-01", gstin: "09AAACH7409R1ZZ", name: "Shree Medicals", lines: [["3005", 5, 10, 12550]] }),
  makeInvoice({ number: "INV/2026-27/0102", date: "2026-11-30", stateCode: "27", name: "Pune Pharma", lines: [["3005", 5, 7, 3333], ["30059040", 18, 3, 9999, "dozen"]] }),
  makeInvoice({ number: "INV/2026-27/0103", date: "2026-11-18", gstin: "27AAPFU0939F1ZV", stateCode: "27", lines: [["30059040", 18, 2, 20000, "dozen"], ["3005", 5, 1, 999]] }),
  // Reversed inside November: never in totals.
  makeInvoice({ number: "INV/2026-27/0104", date: "2026-11-15", status: "reversed", reversedAt: "2026-12-02T06:00:00.000Z", lines: [["3005", 5, 1000, 50000]] }),
  makeInvoice({ number: "INV/2026-27/0105", date: "2026-11-10", status: "reversed", reversedAt: "2026-11-12T06:00:00.000Z", lines: [["3005", 18, 500, 70000]] }),
  // Outside November: never counted.
  makeInvoice({ number: "INV/2026-27/0099", date: "2026-10-31", lines: [["3005", 5, 9, 9999]] }),
  makeInvoice({ number: "INV/2026-27/0110", date: "2026-12-01", lines: [["3005", 5, 9, 9999]] }),
];

const state = { invoices: [] };
const touched = [];

const fakeFind = (filter) => {
  const query = {
    spec: { sort: null, skip: 0, limit: Infinity },
    select: () => query,
    lean: () => query,
    sort: (sort) => ((query.spec.sort = sort), query),
    skip: (skip) => ((query.spec.skip = skip), query),
    limit: (limit) => ((query.spec.limit = limit), query),
    then(resolve, reject) {
      try {
        let docs = state.invoices.filter((doc) => matchDoc(doc, filter));
        if (query.spec.sort) docs = sortDocs(docs, query.spec.sort);
        docs = docs.slice(query.spec.skip, query.spec.skip + query.spec.limit);
        return Promise.resolve(JSON.parse(JSON.stringify(docs))).then(resolve, reject);
      } catch (err) {
        return Promise.reject(err).then(resolve, reject);
      }
    },
  };
  return query;
};

stub("src/models/Invoice", {
  aggregate: async (pipeline) => runPipeline(state.invoices, pipeline),
  find: fakeFind,
  countDocuments: async (filter) => state.invoices.filter((doc) => matchDoc(doc, filter)).length,
});

// Any use of these models by the GST report is a bug.
const recorder = (name) =>
  new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        return (...args) => {
          touched.push(`${name}.${String(prop)}`);
          // Behave like a working model so a leak shows up in the numbers too.
          const rows = [{ _id: null, invoiceCount: 99, taxablePaise: 1000000, cgstPaise: 1, sgstPaise: 1, igstPaise: 1, roundOffPaise: 0, totalPaise: 1000003, taxTotalPaise: 3, mismatchedInvoices: 0 }];
          return Promise.resolve(prop === "aggregate" ? rows : []);
        };
      },
    }
  );
["Estimate", "EstimatePayment", "Challan", "InvoicePayment", "Customer", "StockItem", "CustomerProductPrice"].forEach(
  (name) => stub(`src/models/${name}`, recorder(name))
);

const router = require(path.join(root, "src/routes/gstReport"));

const call = (url, query = {}) =>
  new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(name, value) {
        headers[name.toLowerCase()] = value;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload, headers });
      },
      send(payload) {
        resolve({ status: this.statusCode, body: payload, headers });
      },
    };
    router.handle({ method: "GET", url, query, headers: {} }, res, (err) => resolve({ status: "next", body: err }));
  });

const reset = () => {
  sequence = 0;
  state.invoices = baseInvoices();
  touched.length = 0;
};

const november = (invoices) =>
  invoices.filter(
    (invoice) =>
      invoice.status === "active" &&
      invoice.invoiceDate >= new Date("2026-11-01T00:00:00.000Z") &&
      invoice.invoiceDate < new Date("2026-12-01T00:00:00.000Z")
  );

const originalConsoleError = console.error;

(async () => {
  console.error = () => {};
  try {
    /* 1. Summary: only active GST invoices dated inside the month. */
    reset();
    const expected = sumTotals(november(state.invoices));
    let result = await call("/summary", { month: "2026-11" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const summary = result.body;
    assert.deepEqual(summary.period, { mode: "month", from: "2026-11-01", to: "2026-11-30", label: "November 2026" });
    assert.equal(summary.totals.invoiceCount, 3, "two edge-day invoices plus one mid-month; reversed and out-of-month excluded");
    ["taxablePaise", "cgstPaise", "sgstPaise", "igstPaise", "roundOffPaise", "totalPaise"].forEach((field) =>
      assert.equal(summary.totals[field], expected[field], `totals.${field}`)
    );
    const t = summary.totals;
    assert.equal(t.taxablePaise + t.cgstPaise + t.sgstPaise + t.igstPaise + t.roundOffPaise, t.totalPaise, "totals reconcile to the paisa");
    assert.deepEqual(summary.reconciliation, { mismatchedInvoices: 0, totalsReconcile: true });
    assert.equal(touched.length, 0, `only the Invoice model is queried (touched: ${touched.join(", ")})`);

    // Rate table sums back to the totals.
    const rateSum = (field) => summary.byRate.reduce((sum, row) => sum + row[field], 0);
    assert.deepEqual(summary.byRate.map((row) => row.gstRatePercent), [5, 18]);
    ["taxablePaise", "cgstPaise", "sgstPaise", "igstPaise"].forEach((field) =>
      assert.equal(rateSum(field), t[field], `byRate ${field} sums to totals`)
    );

    // B2B / B2C split by GSTIN, intra / inter by tax type.
    assert.deepEqual(
      summary.bySupplyType.map((row) => [row.supplyType, row.taxType, row.invoiceCount]),
      [["b2b", "inter", 1], ["b2b", "intra", 1], ["b2c", "inter", 1]]
    );
    assert.equal(summary.bySupplyType.reduce((sum, row) => sum + row.totalPaise, 0), t.totalPaise);
    assert.deepEqual(summary.numberRange, { first: "INV/2026-27/0101", last: "INV/2026-27/0102" });

    // Reversed invoices: listed separately, flagged when reversed after the period.
    assert.equal(summary.reversed.count, 2);
    assert.deepEqual(
      summary.reversed.items.map((row) => [row.invoiceNumber, row.reversedAfterPeriod]),
      [["INV/2026-27/0105", false], ["INV/2026-27/0104", true]]
    );
    const reversedTotal = summary.reversed.items.reduce((sum, row) => sum + row.totalPaise, 0);
    assert.ok(reversedTotal > 0);
    assert.notEqual(t.totalPaise, expected.totalPaise + reversedTotal, "reversed amounts are not in the totals");
    assert.deepEqual(summary.warnings, []);

    /* 2. The reconciliation check catches a corrupted invoice. */
    reset();
    state.invoices[0].totalPaise += 1;
    result = await call("/summary", { month: "2026-11" });
    assert.equal(result.body.reconciliation.mismatchedInvoices, 1);
    assert.equal(result.body.reconciliation.totalsReconcile, false);
    assert.match(result.body.warnings[0], /do not reconcile/);

    /* 3. Financial year and custom range modes. */
    reset();
    result = await call("/summary", { fy: "2026-27" });
    assert.equal(result.body.totals.invoiceCount, 5, "every active invoice of the FY");
    result = await call("/summary", { from: "2026-11-18", to: "2026-11-20" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.totals.invoiceCount, 1, "only the 18 Nov invoice");
    assert.equal(result.body.reversed.count, 0, "reversed invoices dated before the range are not listed");

    /* 4. Invalid periods are rejected. */
    for (const query of [{ month: "2026-13" }, { fy: "2026-28" }, { from: "2025-01-01", to: "2026-01-02" }, { month: "2026-11", fy: "2026-27" }]) {
      result = await call("/summary", query);
      assert.equal(result.status, 400, JSON.stringify(query));
    }

    /* 5. Register: paginated, sorted by date then number, reversed excluded. */
    reset();
    result = await call("/invoices", { month: "2026-11", page: "1", limit: "2" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.total, 3);
    assert.equal(result.body.totalPages, 2);
    assert.deepEqual(result.body.items.map((row) => row.invoiceNumber), ["INV/2026-27/0101", "INV/2026-27/0103"]);
    assert.equal(result.body.items[0].gstin, "09AAACH7409R1ZZ");
    assert.equal(result.body.items[0].customerName, "Shree Medicals");
    result = await call("/invoices", { month: "2026-11", page: "2", limit: "2" });
    assert.deepEqual(result.body.items.map((row) => row.invoiceNumber), ["INV/2026-27/0102"]);
    assert.equal(touched.length, 0);

    /* 6. HSN summary: saved line data, tax apportioned exactly within each rate. */
    reset();
    result = await call("/hsn", { month: "2026-11" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const hsn = result.body;
    assert.equal(hsn.taxApportioned, true);
    assert.deepEqual(
      hsn.items.map((row) => [row.hsnCode, row.gstRatePercent, row.unit, row.quantity]),
      [["3005", 5, "pcs", 18], ["30059040", 18, "dozen", 5]]
    );
    assert.equal(hsn.totals.taxablePaise, t.taxablePaise, "HSN taxable = report taxable");
    assert.equal(hsn.totals.taxPaise, t.cgstPaise + t.sgstPaise + t.igstPaise, "HSN tax = report tax");
    summary.byRate.forEach((rate) => {
      const rows = hsn.items.filter((row) => row.gstRatePercent === rate.gstRatePercent);
      assert.equal(rows.reduce((sum, row) => sum + row.taxPaise, 0), rate.taxPaise, `rate ${rate.gstRatePercent} tax`);
    });
    assert.deepEqual(hsn.warnings, []);

    /* 7. A line without HSN is kept as "(missing)" and warned about, never dropped. */
    reset();
    state.invoices[0].lines[0].hsnCode = "";
    result = await call("/hsn", { month: "2026-11" });
    assert.ok(result.body.items.some((row) => row.hsnCode === "(missing)"));
    assert.equal(result.body.totals.taxablePaise, t.taxablePaise, "amounts still reconcile");
    assert.match(result.body.warnings[0], /no HSN code.*INV\/2026-27\/0101/);

    /* 8. CSV export: register. */
    reset();
    state.invoices[0].customerSnapshot.name = '=HYPERLINK("http://evil","x")';
    result = await call("/export.csv", { month: "2026-11", section: "register" });
    assert.equal(result.status, 200, String(result.body).slice(0, 200));
    assert.equal(result.headers["content-type"], "text/csv; charset=utf-8");
    assert.equal(result.headers["content-disposition"], 'attachment; filename="gst-register-2026-11.csv"');
    const csv = result.body;
    assert.ok(csv.startsWith("﻿"), "UTF-8 BOM");
    assert.ok(!/[^\r]\n/.test(csv), "CRLF line endings only");
    const lines = csv.slice(1).trimEnd().split("\r\n");
    assert.equal(lines[0], "GST Invoice Register,November 2026");
    assert.match(lines[1], /^Invoice Date,Invoice No,Customer,GSTIN,Supply Type,State,Tax Type,Taxable Value,CGST,SGST,IGST,Round Off,Invoice Total$/);
    assert.equal(lines.length, 2 + 3 + 1, "period, header, three invoices, TOTAL");
    assert.ok(lines[2].startsWith(`01/11/2026,INV/2026-27/0101,"'=HYPERLINK(""http://evil"",""x"")"`), "formula neutralised and quoted");
    assert.ok(!csv.includes("INV/2026-27/0104") && !csv.includes("INV/2026-27/0105"), "no reversed invoice in the CSV");
    assert.equal(
      lines[5],
      [
        "TOTAL", "3", "", "", "", "", "",
        formatPaiseAsRupees(expected.taxablePaise),
        formatPaiseAsRupees(expected.cgstPaise),
        formatPaiseAsRupees(expected.sgstPaise),
        formatPaiseAsRupees(expected.igstPaise),
        formatPaiseAsRupees(expected.roundOffPaise),
        formatPaiseAsRupees(expected.totalPaise),
      ].join(","),
      "TOTAL row reconciles with the summary"
    );

    /* 9. CSV: rate and HSN sections. */
    result = await call("/export.csv", { month: "2026-11", section: "rate" });
    const rateLines = result.body.slice(1).trimEnd().split("\r\n");
    assert.equal(rateLines[rateLines.length - 1], `Invoice Total,,,,,${formatPaiseAsRupees(expected.totalPaise)}`);
    assert.ok(rateLines.some((line) => line.startsWith("Round Off (invoice level)")));
    result = await call("/export.csv", { fy: "2026-27", section: "hsn" });
    assert.equal(result.headers["content-disposition"], 'attachment; filename="gst-hsn-FY2026-27.csv"');
    assert.ok(result.body.includes("Tax is apportioned within each GST rate by taxable value."));
    assert.equal((await call("/export.csv", { month: "2026-11", section: "estimates" })).status, 400);
    assert.equal(touched.length, 0, `CSV export touches only invoices (touched: ${touched.join(", ")})`);

    /* 10. CSV export cap. */
    reset();
    const bulk = Array.from({ length: 5001 }, (_, index) => ({
      ...state.invoices[0],
      _id: `bulk${index}`,
      invoiceNumber: `INV/2026-27/${10000 + index}`,
    }));
    state.invoices = bulk;
    result = await call("/export.csv", { month: "2026-11", section: "register" });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /at most 5000/);

    /* 11. An empty month reports zeros, not errors. */
    reset();
    result = await call("/summary", { month: "2026-06" });
    assert.equal(result.status, 200);
    assert.equal(result.body.totals.invoiceCount, 0);
    assert.equal(result.body.totals.totalPaise, 0);
    assert.equal(result.body.reconciliation.totalsReconcile, true);
    assert.deepEqual(result.body.byRate, []);
  } finally {
    console.error = originalConsoleError;
  }

  console.log("GST report routes: all assertions passed.");
})().catch((err) => {
  console.error = originalConsoleError;
  console.error(err);
  process.exit(1);
});
