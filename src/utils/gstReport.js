/*
 * GST report helpers (pure, no DB). Step 11F.
 *
 * The report is built from saved GST invoice snapshots only. Amounts are
 * integer paise; rupee text is produced with string math (no float error).
 * Invoice dates are stored as UTC midnight of the Asia/Kolkata business
 * date, so a business-calendar range is a plain UTC range [from, toExclusive).
 */
const { getBusinessToday, getFinancialYear } = require("./salesDocuments");
const { parseDateOnly } = require("./supplierAccounting");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const CSV_MAX_INVOICES = 5000;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const fail = (message) => ({ valid: false, message });

const pad2 = (value) => String(value).padStart(2, "0");
const dateKey = (date) => date.toISOString().slice(0, 10);
const utcDate = (year, monthIndex, day) => new Date(Date.UTC(year, monthIndex, day));

/** DD/MM/YYYY for a date-only value. */
const formatDateKey = (key) => {
  const [year, month, day] = String(key).slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
};

const buildPeriod = (mode, from, toExclusive, label) => {
  const toInclusive = new Date(toExclusive.getTime() - DAY_MS);
  return {
    mode,
    from,
    toExclusive,
    fromKey: dateKey(from),
    toKey: dateKey(toInclusive),
    label,
  };
};

/**
 * Reporting period from the query: exactly one of
 *   month=YYYY-MM | fy=YYYY-YY | from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, <= 366 days)
 * Default: the current Asia/Kolkata month. Periods may not start in the future.
 */
const parseReportPeriod = (query = {}, today = getBusinessToday()) => {
  const hasMonth = query.month !== undefined && query.month !== "";
  const hasFy = query.fy !== undefined && query.fy !== "";
  const hasRange =
    (query.from !== undefined && query.from !== "") || (query.to !== undefined && query.to !== "");

  if ([hasMonth, hasFy, hasRange].filter(Boolean).length > 1) {
    return fail("Choose one period: a month, a financial year or a date range.");
  }

  const monthValue = hasMonth ? query.month : !hasFy && !hasRange ? today.slice(0, 7) : null;

  if (monthValue !== null) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(monthValue));
    const month = match ? Number(match[2]) : 0;
    if (!match || month < 1 || month > 12) return fail("Month must be in YYYY-MM format.");
    const year = Number(match[1]);
    const from = utcDate(year, month - 1, 1);
    if (dateKey(from) > today) return fail("The report month cannot be in the future.");
    return {
      valid: true,
      value: buildPeriod("month", from, utcDate(year, month, 1), `${MONTH_NAMES[month - 1]} ${year}`),
    };
  }

  if (hasFy) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(query.fy));
    const startYear = match ? Number(match[1]) : 0;
    if (!match || Number(match[2]) !== (startYear + 1) % 100) {
      return fail("Financial year must look like 2026-27.");
    }
    const from = utcDate(startYear, 3, 1);
    if (dateKey(from) > today) return fail("The financial year cannot be in the future.");
    return {
      valid: true,
      value: buildPeriod("fy", from, utcDate(startYear + 1, 3, 1), `FY ${query.fy}`),
    };
  }

  const start = parseDateOnly(query.from, "From date");
  if (!start.valid) return start;
  const end = parseDateOnly(query.to, "To date");
  if (!end.valid) return end;
  if (start.value > end.value) return fail("From date cannot be after To date.");
  if (dateKey(end.value) > today) return fail("The report range cannot end in the future.");
  const days = Math.round((end.value - start.value) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) return fail(`A custom range can cover at most ${MAX_RANGE_DAYS} days.`);
  return {
    valid: true,
    value: buildPeriod(
      "range",
      start.value,
      new Date(end.value.getTime() + DAY_MS),
      `${formatDateKey(dateKey(start.value))} to ${formatDateKey(dateKey(end.value))}`
    ),
  };
};

/** Period as returned in API responses. */
const publicPeriod = (period) => ({
  mode: period.mode,
  from: period.fromKey,
  to: period.toKey,
  label: period.label,
});

/** Filename part: 2026-11 / FY2026-27 / 2026-11-01_to_2026-11-30 */
const periodSlug = (period) => {
  if (period.mode === "month") return period.fromKey.slice(0, 7);
  if (period.mode === "fy") return `FY${getFinancialYear(period.fromKey)}`;
  return `${period.fromKey}_to_${period.toKey}`;
};

/* ---------- money ---------- */

/** 12550 -> "125.50", -26 -> "-0.26". Integer string math only. */
const formatPaiseAsRupees = (paise) => {
  if (!Number.isSafeInteger(paise)) throw new Error("Amount must be whole paise.");
  const sign = paise < 0 ? "-" : "";
  const absolute = Math.abs(paise);
  return `${sign}${Math.floor(absolute / 100)}.${pad2(absolute % 100)}`;
};

const AMOUNT_FIELDS = ["taxablePaise", "cgstPaise", "sgstPaise", "igstPaise", "roundOffPaise", "totalPaise"];

/** taxable + CGST + SGST + IGST + round-off === total (to the paisa). */
const reconciles = (row) =>
  row.taxablePaise + row.cgstPaise + row.sgstPaise + row.igstPaise + row.roundOffPaise ===
  row.totalPaise;

const sumTotals = (rows) =>
  rows.reduce(
    (totals, row) => {
      AMOUNT_FIELDS.forEach((field) => {
        totals[field] += Number(row[field]) || 0;
      });
      totals.invoiceCount += 1;
      return totals;
    },
    {
      invoiceCount: 0,
      taxablePaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      roundOffPaise: 0,
      totalPaise: 0,
    }
  );

/* ---------- HSN tax apportionment ---------- */

/** Splits `total` across `weights` (largest remainder); always sums to `total`. */
const splitByWeight = (total, weights) => {
  if (weights.length === 0) return [];
  const totalBig = BigInt(total);
  const weightSum = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (weightSum === 0n) {
    // Nothing to weigh by (all taxable 0): the whole amount goes to the first row.
    return weights.map((weight, index) => (index === 0 ? total : 0));
  }
  const parts = weights.map((weight, index) => {
    const product = totalBig * BigInt(weight);
    return { index, base: product / weightSum, remainder: product % weightSum };
  });
  let left = totalBig - parts.reduce((sum, part) => sum + part.base, 0n);
  [...parts]
    .sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index))
    .forEach((part) => {
      if (left > 0n) {
        part.base += 1n;
        left -= 1n;
      }
    });
  return parts.map((part) => Number(part.base));
};

/**
 * Tax per HSN is not stored (11C computes GST once per rate group), so each
 * rate's exact CGST/SGST/IGST is apportioned across that rate's HSN rows by
 * taxable value. HSN taxes therefore sum exactly to the rate totals.
 */
const apportionTax = (rateRows, hsnRows) => {
  const byRate = new Map(rateRows.map((row) => [row.gstRatePercent, row]));
  const grouped = new Map();
  hsnRows.forEach((row) => {
    const list = grouped.get(row.gstRatePercent) || [];
    list.push({ ...row });
    grouped.set(row.gstRatePercent, list);
  });

  const result = [];
  [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .forEach(([rate, rows]) => {
      rows.sort((a, b) =>
        a.hsnCode < b.hsnCode ? -1 : a.hsnCode > b.hsnCode ? 1 : String(a.unit).localeCompare(String(b.unit))
      );
      const totals = byRate.get(rate) || { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
      const weights = rows.map((row) => row.taxablePaise);
      const cgst = splitByWeight(totals.cgstPaise, weights);
      const sgst = splitByWeight(totals.sgstPaise, weights);
      const igst = splitByWeight(totals.igstPaise, weights);
      rows.forEach((row, index) => {
        result.push({
          ...row,
          cgstPaise: cgst[index],
          sgstPaise: sgst[index],
          igstPaise: igst[index],
          taxPaise: cgst[index] + sgst[index] + igst[index],
        });
      });
    });
  return result;
};

/* ---------- CSV ---------- */

// A text cell starting with one of these could run as a spreadsheet formula.
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMERIC_CELL = /^-?\d+(\.\d+)?$/;

/**
 * One CSV cell. Text cells that could start a spreadsheet formula get a
 * leading apostrophe; cells with a comma, quote or line break are quoted.
 * Numeric cells (our own formatted amounts and counts) stay numeric.
 */
const escapeCsvCell = (value, { numeric = false } = {}) => {
  let text = value === undefined || value === null ? "" : String(value);
  const isNumber = numeric && NUMERIC_CELL.test(text);
  if (!isNumber && FORMULA_START.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
};

const money = (paise) => ({ value: formatPaiseAsRupees(paise), numeric: true });
const count = (value) => ({ value: String(value), numeric: true });

/** UTF-8 BOM, CRLF line endings. Cells are strings or { value, numeric }. */
const buildCsv = (rows) =>
  `﻿${rows
    .map((row) =>
      row
        .map((cell) =>
          cell !== null && typeof cell === "object"
            ? escapeCsvCell(cell.value, { numeric: cell.numeric })
            : escapeCsvCell(cell)
        )
        .join(",")
    )
    .join("\r\n")}\r\n`;

module.exports = {
  AMOUNT_FIELDS,
  CSV_MAX_INVOICES,
  MAX_RANGE_DAYS,
  apportionTax,
  buildCsv,
  count,
  escapeCsvCell,
  formatDateKey,
  formatPaiseAsRupees,
  money,
  parseReportPeriod,
  periodSlug,
  publicPeriod,
  reconciles,
  splitByWeight,
  sumTotals,
};
