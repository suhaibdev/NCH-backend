/*
 * Monthly GST Report (Step 11F). Admin only; mounted at /api/reports/gst.
 *
 * Built ONLY from saved GST invoice snapshots, aggregated on the server with
 * a date-range filter. Estimates and challans never appear: this file imports
 * the Invoice model and nothing else. Reversed invoices are excluded from all
 * totals and listed separately. Nothing is recomputed from current product
 * or customer data.
 *
 * Every query matches { status, invoiceDate } and uses the
 * { status: 1, invoiceDate: -1, _id: -1 } index.
 */
const express = require("express");

const Invoice = require("../models/Invoice");
const { buildPagedResponse, parseOptionalPagination } = require("../utils/listQuery");
const { sendServerError } = require("../utils/httpErrors");
const { getStateName } = require("../utils/gst");
const { getBusinessToday } = require("../utils/salesDocuments");
const {
  CSV_MAX_INVOICES,
  apportionTax,
  buildCsv,
  count,
  formatDateKey,
  money,
  parseReportPeriod,
  periodSlug,
  publicPeriod,
  sumTotals,
} = require("../utils/gstReport");

const router = express.Router();

const REVERSED_LIST_CAP = 200;
const TAX_TYPE_LABELS = { intra: "CGST + SGST", inter: "IGST" };

const SUM_AMOUNTS = {
  taxablePaise: { $sum: "$taxablePaise" },
  cgstPaise: { $sum: "$cgstPaise" },
  sgstPaise: { $sum: "$sgstPaise" },
  igstPaise: { $sum: "$igstPaise" },
  roundOffPaise: { $sum: "$roundOffPaise" },
  totalPaise: { $sum: "$totalPaise" },
};

const RATE_GROUP = [
  { $unwind: "$taxSummary" },
  {
    $group: {
      _id: "$taxSummary.gstRatePercent",
      taxablePaise: { $sum: "$taxSummary.taxablePaise" },
      cgstPaise: { $sum: "$taxSummary.cgstPaise" },
      sgstPaise: { $sum: "$taxSummary.sgstPaise" },
      igstPaise: { $sum: "$taxSummary.igstPaise" },
      taxPaise: { $sum: "$taxSummary.taxPaise" },
    },
  },
  { $sort: { _id: 1 } },
];

const REGISTER_FIELDS =
  "invoiceNumber invoiceDate sequence customerSnapshot taxType taxablePaise cgstPaise sgstPaise igstPaise roundOffPaise totalPaise";

/** Only reportable sales: active invoices dated inside the period. */
const activeMatch = (period) => ({
  status: "active",
  invoiceDate: { $gte: period.from, $lt: period.toExclusive },
});

const reversedMatch = (period) => ({
  status: "reversed",
  invoiceDate: { $gte: period.from, $lt: period.toExclusive },
});

const readPeriod = (req, res) => {
  const result = parseReportPeriod(req.query || {});
  if (!result.valid) {
    res.status(400).json({ message: result.message });
    return null;
  }
  return result.value;
};

const toRateRow = (row) => ({
  gstRatePercent: row._id,
  taxablePaise: row.taxablePaise,
  cgstPaise: row.cgstPaise,
  sgstPaise: row.sgstPaise,
  igstPaise: row.igstPaise,
  taxPaise: row.taxPaise,
});

const toRegisterRow = (invoice) => ({
  _id: invoice._id,
  invoiceNumber: invoice.invoiceNumber,
  invoiceDate: invoice.invoiceDate,
  customerName: invoice.customerSnapshot?.billingName || invoice.customerSnapshot?.name || "",
  gstin: invoice.customerSnapshot?.gstin || "",
  stateCode: invoice.customerSnapshot?.stateCode || "",
  taxType: invoice.taxType,
  taxablePaise: invoice.taxablePaise,
  cgstPaise: invoice.cgstPaise,
  sgstPaise: invoice.sgstPaise,
  igstPaise: invoice.igstPaise,
  roundOffPaise: invoice.roundOffPaise,
  totalPaise: invoice.totalPaise,
});

const registerQuery = (period) =>
  Invoice.find(activeMatch(period))
    .select(REGISTER_FIELDS)
    .sort({ invoiceDate: 1, sequence: 1, _id: 1 });

/** HSN rows (from saved lines) with tax apportioned within each rate. */
const loadHsn = async (period) => {
  const [facet] = await Invoice.aggregate([
    { $match: activeMatch(period) },
    {
      $facet: {
        hsn: [
          { $unwind: "$lines" },
          {
            $group: {
              _id: {
                hsnCode: { $ifNull: ["$lines.hsnCode", ""] },
                gstRatePercent: "$lines.gstRatePercent",
                unit: "$lines.unit",
              },
              quantity: { $sum: "$lines.quantity" },
              taxablePaise: { $sum: "$lines.taxablePaise" },
              lineCount: { $sum: 1 },
            },
          },
        ],
        byRate: RATE_GROUP,
      },
    },
  ]);

  const rateRows = (facet?.byRate || []).map(toRateRow);
  const hsnRows = (facet?.hsn || []).map((row) => ({
    hsnCode: row._id.hsnCode || "",
    gstRatePercent: row._id.gstRatePercent,
    unit: row._id.unit,
    quantity: row.quantity,
    taxablePaise: row.taxablePaise,
    lineCount: row.lineCount,
  }));

  const warnings = [];
  const missing = hsnRows.filter((row) => !row.hsnCode);
  if (missing.length > 0) {
    // Should be impossible (the schema requires an HSN on every invoice line).
    const affected = await Invoice.find({
      ...activeMatch(period),
      $or: [{ "lines.hsnCode": "" }, { "lines.hsnCode": null }, { "lines.hsnCode": { $exists: false } }],
    })
      .select("invoiceNumber")
      .limit(50)
      .lean();
    warnings.push(
      `${missing.reduce((sum, row) => sum + row.lineCount, 0)} invoice line(s) have no HSN code and are shown as "(missing)": ${affected
        .map((invoice) => invoice.invoiceNumber)
        .join(", ")}.`
    );
  }

  const items = apportionTax(rateRows, hsnRows).map(({ lineCount, ...row }) => ({
    ...row,
    hsnCode: row.hsnCode || "(missing)",
  }));
  const totals = items.reduce(
    (sum, row) => ({
      quantity: sum.quantity + row.quantity,
      taxablePaise: sum.taxablePaise + row.taxablePaise,
      cgstPaise: sum.cgstPaise + row.cgstPaise,
      sgstPaise: sum.sgstPaise + row.sgstPaise,
      igstPaise: sum.igstPaise + row.igstPaise,
      taxPaise: sum.taxPaise + row.taxPaise,
    }),
    { quantity: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0 }
  );

  return { items, totals, warnings, rateRows };
};

/* ==========================================================
   SUMMARY: totals, by rate, B2B/B2C, number range, reversed list
   GET /api/reports/gst/summary?month=YYYY-MM | fy=YYYY-YY | from&to
========================================================== */

router.get("/summary", async (req, res) => {
  const period = readPeriod(req, res);
  if (!period) return undefined;

  try {
    const [facet] = await Invoice.aggregate([
      { $match: activeMatch(period) },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                invoiceCount: { $sum: 1 },
                ...SUM_AMOUNTS,
                taxTotalPaise: { $sum: "$taxTotalPaise" },
                // Reconciliation check, per invoice, inside the aggregation.
                mismatchedInvoices: {
                  $sum: {
                    $cond: [
                      {
                        $ne: [
                          {
                            $add: [
                              "$taxablePaise",
                              "$cgstPaise",
                              "$sgstPaise",
                              "$igstPaise",
                              "$roundOffPaise",
                            ],
                          },
                          "$totalPaise",
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ],
          byRate: RATE_GROUP,
          bySupplyType: [
            {
              $group: {
                _id: {
                  b2b: { $gt: [{ $strLenCP: { $ifNull: ["$customerSnapshot.gstin", ""] } }, 0] },
                  taxType: "$taxType",
                },
                invoiceCount: { $sum: 1 },
                ...SUM_AMOUNTS,
              },
            },
          ],
          numberRange: [
            { $sort: { invoiceDate: 1, sequence: 1 } },
            {
              $group: {
                _id: null,
                first: { $first: "$invoiceNumber" },
                last: { $last: "$invoiceNumber" },
              },
            },
          ],
        },
      },
    ]);

    const totalsRow = facet?.totals?.[0];
    const totals = {
      invoiceCount: totalsRow?.invoiceCount || 0,
      taxablePaise: totalsRow?.taxablePaise || 0,
      cgstPaise: totalsRow?.cgstPaise || 0,
      sgstPaise: totalsRow?.sgstPaise || 0,
      igstPaise: totalsRow?.igstPaise || 0,
      taxTotalPaise: totalsRow?.taxTotalPaise || 0,
      roundOffPaise: totalsRow?.roundOffPaise || 0,
      totalPaise: totalsRow?.totalPaise || 0,
    };
    const mismatchedInvoices = totalsRow?.mismatchedInvoices || 0;
    const totalsReconcile =
      totals.taxablePaise + totals.cgstPaise + totals.sgstPaise + totals.igstPaise + totals.roundOffPaise ===
      totals.totalPaise;

    const bySupplyType = (facet?.bySupplyType || [])
      .map((row) => ({
        supplyType: row._id.b2b ? "b2b" : "b2c",
        taxType: row._id.taxType,
        invoiceCount: row.invoiceCount,
        taxablePaise: row.taxablePaise,
        cgstPaise: row.cgstPaise,
        sgstPaise: row.sgstPaise,
        igstPaise: row.igstPaise,
        roundOffPaise: row.roundOffPaise,
        totalPaise: row.totalPaise,
      }))
      .sort((a, b) => `${a.supplyType}${a.taxType}`.localeCompare(`${b.supplyType}${b.taxType}`));

    const [reversedRows, reversedCount] = await Promise.all([
      Invoice.find(reversedMatch(period))
        .select("invoiceNumber invoiceDate reversedAt totalPaise")
        .sort({ invoiceDate: 1, sequence: 1, _id: 1 })
        .limit(REVERSED_LIST_CAP)
        .lean(),
      Invoice.countDocuments(reversedMatch(period)),
    ]);

    const warnings = [];
    if (mismatchedInvoices > 0) {
      warnings.push(`${mismatchedInvoices} invoice(s) do not reconcile. Check them before filing.`);
    }

    return res.json({
      period: publicPeriod(period),
      totals,
      byRate: (facet?.byRate || []).map(toRateRow),
      bySupplyType,
      numberRange: {
        first: facet?.numberRange?.[0]?.first || "",
        last: facet?.numberRange?.[0]?.last || "",
      },
      reconciliation: { mismatchedInvoices, totalsReconcile: totalsReconcile && mismatchedInvoices === 0 },
      reversed: {
        count: reversedCount,
        items: reversedRows.map((invoice) => ({
          _id: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate,
          reversedAt: invoice.reversedAt,
          totalPaise: invoice.totalPaise,
          // Reversed after the period ended: an already-filed month changes on re-run.
          reversedAfterPeriod: Boolean(
            invoice.reversedAt && getBusinessToday(new Date(invoice.reversedAt)) > period.toKey
          ),
        })),
      },
      warnings,
    });
  } catch (err) {
    return sendServerError(res, "GST REPORT SUMMARY", err, "Unable to load the GST report.");
  }
});

/* ==========================================================
   REGISTER: one row per active invoice, paginated
   GET /api/reports/gst/invoices?page&limit&<period>
========================================================== */

router.get("/invoices", async (req, res) => {
  const period = readPeriod(req, res);
  if (!period) return undefined;

  try {
    const paging = parseOptionalPagination(
      { page: req.query.page ?? 1, limit: req.query.limit },
      { cap: 100, maxLimit: 100, defaultLimit: 20 }
    );
    const [rows, total] = await Promise.all([
      registerQuery(period).skip(paging.skip).limit(paging.limit).lean(),
      Invoice.countDocuments(activeMatch(period)),
    ]);
    return res.json({
      period: publicPeriod(period),
      ...buildPagedResponse(rows.map(toRegisterRow), paging, total),
    });
  } catch (err) {
    return sendServerError(res, "GST REPORT REGISTER", err, "Unable to load the invoice register.");
  }
});

/* ==========================================================
   HSN SUMMARY (tax apportioned within each rate)
   GET /api/reports/gst/hsn?<period>
========================================================== */

router.get("/hsn", async (req, res) => {
  const period = readPeriod(req, res);
  if (!period) return undefined;

  try {
    const { items, totals, warnings } = await loadHsn(period);
    return res.json({ period: publicPeriod(period), items, totals, taxApportioned: true, warnings });
  } catch (err) {
    return sendServerError(res, "GST REPORT HSN", err, "Unable to load the HSN summary.");
  }
});

/* ==========================================================
   CSV EXPORT
   GET /api/reports/gst/export.csv?section=register|rate|hsn&<period>
========================================================== */

const stateText = (code) => (code ? `${code} ${getStateName(code)}`.trim() : "");

router.get("/export.csv", async (req, res) => {
  const period = readPeriod(req, res);
  if (!period) return undefined;

  const section = req.query.section || "register";
  if (!["register", "rate", "hsn"].includes(section)) {
    return res.status(400).json({ message: "Section must be register, rate or hsn." });
  }

  try {
    let rows;

    if (section === "register") {
      const invoiceCount = await Invoice.countDocuments(activeMatch(period));
      if (invoiceCount > CSV_MAX_INVOICES) {
        return res.status(400).json({
          message: `This period has ${invoiceCount} invoices. Export at most ${CSV_MAX_INVOICES} at a time; choose a shorter period.`,
        });
      }
      const invoices = (await registerQuery(period).limit(CSV_MAX_INVOICES).lean()).map(toRegisterRow);
      const totals = sumTotals(invoices);
      rows = [
        ["GST Invoice Register", period.label],
        [
          "Invoice Date",
          "Invoice No",
          "Customer",
          "GSTIN",
          "Supply Type",
          "State",
          "Tax Type",
          "Taxable Value",
          "CGST",
          "SGST",
          "IGST",
          "Round Off",
          "Invoice Total",
        ],
        ...invoices.map((invoice) => [
          formatDateKey(new Date(invoice.invoiceDate).toISOString()),
          invoice.invoiceNumber,
          invoice.customerName,
          invoice.gstin,
          invoice.gstin ? "B2B" : "B2C",
          stateText(invoice.stateCode),
          TAX_TYPE_LABELS[invoice.taxType] || invoice.taxType,
          money(invoice.taxablePaise),
          money(invoice.cgstPaise),
          money(invoice.sgstPaise),
          money(invoice.igstPaise),
          money(invoice.roundOffPaise),
          money(invoice.totalPaise),
        ]),
        [
          "TOTAL",
          count(totals.invoiceCount),
          "",
          "",
          "",
          "",
          "",
          money(totals.taxablePaise),
          money(totals.cgstPaise),
          money(totals.sgstPaise),
          money(totals.igstPaise),
          money(totals.roundOffPaise),
          money(totals.totalPaise),
        ],
      ];
    } else if (section === "rate") {
      const [facet] = await Invoice.aggregate([
        { $match: activeMatch(period) },
        {
          $facet: {
            byRate: RATE_GROUP,
            totals: [{ $group: { _id: null, ...SUM_AMOUNTS } }],
          },
        },
      ]);
      const rateRows = (facet?.byRate || []).map(toRateRow);
      const totals = facet?.totals?.[0] || {
        taxablePaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        roundOffPaise: 0,
        totalPaise: 0,
      };
      const taxSum = rateRows.reduce((sum, row) => sum + row.taxPaise, 0);
      rows = [
        ["GST Rate-wise Summary", period.label],
        ["GST Rate %", "Taxable Value", "CGST", "SGST", "IGST", "Tax"],
        ...rateRows.map((row) => [
          count(row.gstRatePercent),
          money(row.taxablePaise),
          money(row.cgstPaise),
          money(row.sgstPaise),
          money(row.igstPaise),
          money(row.taxPaise),
        ]),
        [
          "TOTAL",
          money(totals.taxablePaise),
          money(totals.cgstPaise),
          money(totals.sgstPaise),
          money(totals.igstPaise),
          money(taxSum),
        ],
        ["Round Off (invoice level)", "", "", "", "", money(totals.roundOffPaise)],
        ["Invoice Total", "", "", "", "", money(totals.totalPaise)],
      ];
    } else {
      const { items, totals, warnings } = await loadHsn(period);
      rows = [
        ["GST HSN-wise Summary", period.label],
        ["Tax is apportioned within each GST rate by taxable value."],
        ...warnings.map((warning) => ["Warning", warning]),
        ["HSN", "GST Rate %", "Unit", "Quantity", "Taxable Value", "CGST", "SGST", "IGST", "Tax"],
        ...items.map((row) => [
          row.hsnCode,
          count(row.gstRatePercent),
          row.unit === "dozen" ? "Dozen" : row.unit === "pcs" ? "PCS" : row.unit,
          count(row.quantity),
          money(row.taxablePaise),
          money(row.cgstPaise),
          money(row.sgstPaise),
          money(row.igstPaise),
          money(row.taxPaise),
        ]),
        [
          "TOTAL",
          "",
          "",
          count(totals.quantity),
          money(totals.taxablePaise),
          money(totals.cgstPaise),
          money(totals.sgstPaise),
          money(totals.igstPaise),
          money(totals.taxPaise),
        ],
      ];
    }

    const filename = `gst-${section}-${periodSlug(period)}.csv`;
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buildCsv(rows));
  } catch (err) {
    return sendServerError(res, "GST REPORT EXPORT", err, "Unable to export the GST report.");
  }
});

module.exports = router;
