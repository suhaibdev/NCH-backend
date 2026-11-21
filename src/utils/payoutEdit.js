/*
 * Payout edit rules (single Payout and BulkPayout lines). Pure and DB-free:
 * routes load data, these helpers decide. Used both before a transaction and
 * again inside it on freshly read data.
 *
 * Editable: paymentMethod, advanceDeducted (Advance Cut), deductions (Other
 * Deduction). Everything else on a payout is a frozen snapshot.
 *
 * CHRONOLOGY
 * Payouts for one employee never overlap, so their end dates order them.
 * Positions are compared by calendar day key (toPayoutDayKey for payouts,
 * toAttendanceDayKey for attendance) so the result is server-time-zone safe.
 *   advancesAt(E)  = sum of attendance advancePayment with day <= E
 *   cutsBefore(P)  = sum of advanceDeducted of OTHER payouts ending <= P.end
 *   outstanding(P) = max(0, advancesAt(P.end) - cutsBefore(P))
 * A new cut must be <= outstanding(P). When the cut is raised, every LATER
 * payout L must still satisfy L.cut <= advancesAt(L.end) - cuts ending before L.
 */
const { calculateNetSalary, toFiniteNumber, validateNetSalary } = require("./payroll");
const { getOverlapDetails, toAttendanceDayKey, toPayoutDayKey } = require("./payoutOverlap");

const VALID_PAYMENT_METHODS = ["cash", "upi", "bank", "cheque"];

const SINGLE_EDIT_KEYS = ["paymentMethod", "advanceDeducted", "deductions"];
const BULK_EDIT_KEYS = ["paymentMethod", "employees"];
const BULK_LINE_EDIT_KEYS = ["employeeId", "advanceDeducted", "deductions"];
const AMOUNT_KEYS = ["advanceDeducted", "deductions"];

const CHRONOLOGY_CONFLICT = "ADVANCE_CHRONOLOGY_CONFLICT";

const roundCurrency = (value) => Math.round(value * 100) / 100;
const toPaise = (value) => Math.round(toFiniteNumber(value) * 100);
const sameAmount = (a, b) => toPaise(a) === toPaise(b);
const formatRupees = (value) => `₹${roundCurrency(toFiniteNumber(value))}`;

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (source, key) => Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined;

const fail = (status, message, extra = {}) => ({ ok: false, status, message, ...extra });

const forbiddenKeys = (source, allowed) => Object.keys(source).filter((key) => !allowed.includes(key));

const AMOUNT_LABELS = { advanceDeducted: "Advance deduction", deductions: "Other deduction" };

/** Same coercion as create (`Number(v || 0)`), then rounded to paise. */
const parseAmount = (value, key) => {
  const label = AMOUNT_LABELS[key];
  if (value !== null && typeof value !== "number" && typeof value !== "string") {
    return { error: `${label} must be a valid number.` };
  }
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return { error: `${label} must be a valid number.` };
  if (number < 0) return { error: `${label} cannot be negative.` };
  return { value: roundCurrency(number) };
};

const parseAmounts = (source, prefix = "") => {
  const amounts = {};
  for (const key of AMOUNT_KEYS) {
    if (!has(source, key)) continue;
    const parsed = parseAmount(source[key], key);
    if (parsed.error) return { error: `${prefix}${parsed.error}` };
    amounts[key] = parsed.value;
  }
  return { amounts };
};

const parsePaymentMethod = (source) => {
  if (!has(source, "paymentMethod")) return { present: false };
  if (!VALID_PAYMENT_METHODS.includes(source.paymentMethod)) {
    return { error: "Invalid payment method provided." };
  }
  return { present: true, value: source.paymentMethod };
};

const rejectForbidden = (source, allowed, prefix = "") => {
  const bad = forbiddenKeys(source, allowed);
  return bad.length ? fail(400, `${prefix}These fields cannot be edited: ${bad.join(", ")}.`) : null;
};

/* ---------------- body parsing ---------------- */

const parseSingleEditBody = (body) => {
  if (!isPlainObject(body)) return fail(400, "Request body must be an object.");
  const forbidden = rejectForbidden(body, SINGLE_EDIT_KEYS);
  if (forbidden) return forbidden;
  if (!SINGLE_EDIT_KEYS.some((key) => has(body, key))) {
    return fail(400, "Nothing to edit. Send paymentMethod, advanceDeducted or deductions.");
  }

  const method = parsePaymentMethod(body);
  if (method.error) return fail(400, method.error);
  const { amounts, error } = parseAmounts(body);
  if (error) return fail(400, error);

  const edits = { ...amounts };
  if (method.present) edits.paymentMethod = method.value;
  return { ok: true, edits };
};

const parseBulkEditBody = (body) => {
  if (!isPlainObject(body)) return fail(400, "Request body must be an object.");
  const forbidden = rejectForbidden(body, BULK_EDIT_KEYS);
  if (forbidden) return forbidden;

  const method = parsePaymentMethod(body);
  if (method.error) return fail(400, method.error);

  if (has(body, "employees") && !Array.isArray(body.employees)) {
    return fail(400, "employees must be an array.");
  }
  const rawLines = body.employees || [];
  const lines = [];
  const seen = new Set();

  for (const raw of rawLines) {
    if (!isPlainObject(raw)) return fail(400, "Each employee edit must be an object.");
    const lineForbidden = rejectForbidden(raw, BULK_LINE_EDIT_KEYS, "Employee edit: ");
    if (lineForbidden) return lineForbidden;
    const employeeId = String(raw.employeeId || "");
    if (!OBJECT_ID_PATTERN.test(employeeId)) return fail(400, "Each employee edit needs a valid employeeId.");
    if (seen.has(employeeId)) return fail(400, "An employee can only appear once in a bulk payout edit.");
    seen.add(employeeId);
    const { amounts, error } = parseAmounts(raw, "");
    if (error) return fail(400, error);
    lines.push({ employeeId, ...amounts });
  }

  if (!method.present && lines.length === 0) {
    return fail(400, "Nothing to edit. Send paymentMethod and/or employees.");
  }

  const edits = { lines };
  if (method.present) edits.paymentMethod = method.value;
  return { ok: true, edits };
};

/* ---------------- chronology ---------------- */

/** Identifies the payout being edited inside an employee's payout history. */
const isSameRef = (entry, ref) =>
  String(entry._id) === String(ref.id) &&
  (entry.overlapSource === "bulk") === (ref.sourceType === "bulk");

const sumAdvancesUpTo = (attendance, dayKey) =>
  roundCurrency(
    attendance.reduce((sum, record) => {
      const key = toAttendanceDayKey(record.date);
      return key && key <= dayKey ? sum + toFiniteNumber(record.advancePayment) : sum;
    }, 0)
  );

/** Outstanding advance at the edited payout's position (other payouts only). */
const getAdvancePosition = (attendance, history, ref, endDate) => {
  const endKey = toPayoutDayKey(endDate);
  const advancesTaken = sumAdvancesUpTo(attendance, endKey);
  const cutsBefore = roundCurrency(
    history.reduce((sum, entry) => {
      if (isSameRef(entry, ref)) return sum;
      const key = toPayoutDayKey(entry.endDate);
      return key && key <= endKey ? sum + toFiniteNumber(entry.advanceDeducted) : sum;
    }, 0)
  );
  return {
    endKey,
    advancesTaken,
    cutsBefore,
    outstanding: roundCurrency(Math.max(0, advancesTaken - cutsBefore)),
  };
};

/**
 * With the edited payout's cut replaced by `newCut`, returns the first LATER
 * payout whose recorded advance cut exceeds what would then be available.
 */
const findLaterAdvanceConflict = (attendance, history, ref, endDate, newCut) => {
  const endKey = toPayoutDayKey(endDate);
  const entries = history
    .map((entry) => ({
      entry,
      key: toPayoutDayKey(entry.endDate),
      cut: isSameRef(entry, ref) ? newCut : toFiniteNumber(entry.advanceDeducted),
      self: isSameRef(entry, ref),
    }))
    .filter((item) => item.key);

  const later = entries.filter((item) => !item.self && item.key > endKey).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  for (const target of later) {
    const cutsBefore = entries.reduce(
      (sum, item) => (item !== target && item.key < target.key ? sum + item.cut : sum),
      0
    );
    const available = roundCurrency(Math.max(0, sumAdvancesUpTo(attendance, target.key) - cutsBefore));
    if (toPaise(target.cut) > toPaise(available)) {
      return { payout: target.entry, recordedAdvanceDeducted: roundCurrency(target.cut), availableAdvance: available };
    }
  }
  return null;
};

const describeConflict = (conflict) => {
  const details = getOverlapDetails(conflict.payout);
  const isBulk = details.sourceType === "bulk";
  const payoutNumber = isBulk ? details.parentBulkPayout.payoutNumber : conflict.payout.salarySlipNumber || "";
  return {
    ...details,
    payoutId: isBulk ? details.parentBulkPayout.id : conflict.payout._id,
    payoutNumber,
    recordedAdvanceDeducted: conflict.recordedAdvanceDeducted,
    availableAdvance: conflict.availableAdvance,
  };
};

const toDayLabel = (value) => toPayoutDayKey(value) || "?";

/* ---------------- recalculation ---------------- */

const recalculateLine = (line, { advanceDeducted, deductions, outstandingBefore }) => {
  const before = roundCurrency(toFiniteNumber(outstandingBefore));
  return {
    advanceDeducted,
    deductions,
    outstandingAdvanceBefore: before,
    outstandingAdvanceAfter: roundCurrency(Math.max(0, before - advanceDeducted)),
    netSalary: calculateNetSalary(line.grossSalary, advanceDeducted, deductions),
  };
};

const BULK_TOTALS = {
  totalGross: "grossSalary",
  totalAdvanceCut: "advanceDeducted",
  totalAdvanceLeft: "outstandingAdvanceAfter",
  totalOtherDeduction: "deductions",
  totalNetPaid: "netSalary",
};

const recomputeBulkTotals = (lines) =>
  Object.fromEntries(
    Object.entries(BULK_TOTALS).map(([total, field]) => [
      total,
      roundCurrency(lines.reduce((sum, line) => sum + toFiniteNumber(line[field]), 0)),
    ])
  );

/**
 * Validates new amounts for one payout/line (cap -> net -> later payouts) and
 * returns the recalculated snapshot fields.
 */
const validateLineEdit = ({ line, ref, endDate, amounts, attendance, history, employeeName, namePrefix = false }) => {
  const oldCut = roundCurrency(toFiniteNumber(line.advanceDeducted));
  const newCut = has(amounts, "advanceDeducted") ? amounts.advanceDeducted : oldCut;
  const newDeductions = has(amounts, "deductions") ? amounts.deductions : roundCurrency(toFiniteNumber(line.deductions));
  const prefix = namePrefix ? `${employeeName || "Employee"}: ` : "";

  const position = getAdvancePosition(attendance, history, ref, endDate);
  if (toPaise(newCut) > toPaise(position.outstanding)) {
    return fail(400, `${prefix}Maximum recoverable advance is ${formatRupees(position.outstanding)}`);
  }

  const netCheck = validateNetSalary(line.grossSalary, newCut, newDeductions, employeeName);
  if (!netCheck.valid) return fail(400, netCheck.message);

  if (toPaise(newCut) > toPaise(oldCut)) {
    const conflict = findLaterAdvanceConflict(attendance, history, ref, endDate, newCut);
    if (conflict) {
      const details = describeConflict(conflict);
      const name = employeeName || "Employee";
      return fail(
        409,
        `Raising ${name}'s advance cut to ${formatRupees(newCut)} would overdraw later payout ` +
          `${details.payoutNumber || details.sourceLabel} (${toDayLabel(details.startDate)} to ${toDayLabel(details.endDate)}): ` +
          `it recovers ${formatRupees(details.recordedAdvanceDeducted)} but only ${formatRupees(details.availableAdvance)} would be available.`,
        { code: CHRONOLOGY_CONFLICT, employeeName: name, conflict: details }
      );
    }
  }

  return {
    ok: true,
    values: recalculateLine(line, { advanceDeducted: newCut, deductions: newDeductions, outstandingBefore: position.outstanding }),
  };
};

const amountsChanged = (line, amounts) =>
  AMOUNT_KEYS.some((key) => has(amounts, key) && !sameAmount(amounts[key], line[key]));

/* ---------------- planners ---------------- */

/**
 * Single payout. `context` = { attendance, history, employeeName } for the
 * payout's employee. Returns { ok:false,... } | { ok:true, noop:true } |
 * { ok:true, noop:false, set }.
 */
const planSingleEdit = (payout, edits, context) => {
  const methodChanged = has(edits, "paymentMethod") && edits.paymentMethod !== payout.paymentMethod;
  const changedAmounts = amountsChanged(payout, edits);
  if (!methodChanged && !changedAmounts) return { ok: true, noop: true };

  const set = {};
  if (methodChanged) set.paymentMethod = edits.paymentMethod;
  if (changedAmounts) {
    const result = validateLineEdit({
      line: payout,
      ref: { sourceType: "single", id: payout._id },
      endDate: payout.endDate,
      amounts: edits,
      attendance: context.attendance,
      history: context.history,
      employeeName: context.employeeName,
    });
    if (!result.ok) return result;
    Object.assign(set, result.values);
  }
  return { ok: true, noop: false, set };
};

/** Employee IDs (strings) whose amounts actually change; they need context. */
const getBulkChangedEmployeeIds = (bulk, edits) => {
  const lineById = new Map((bulk.employees || []).map((line) => [String(line.employee), line]));
  return edits.lines
    .filter((edit) => lineById.has(edit.employeeId) && amountsChanged(lineById.get(edit.employeeId), edit))
    .map((edit) => edit.employeeId);
};

/**
 * Bulk payout. `contextByEmployee` = Map(employeeId -> { attendance, history })
 * for every ID from getBulkChangedEmployeeIds.
 */
const planBulkEdit = (bulk, edits, contextByEmployee) => {
  const lines = bulk.employees || [];
  const lineIds = new Set(lines.map((line) => String(line.employee)));
  const unknown = edits.lines.find((edit) => !lineIds.has(edit.employeeId));
  if (unknown) return fail(400, `Employee ${unknown.employeeId} is not part of this bulk payout.`);

  const editById = new Map(edits.lines.map((edit) => [edit.employeeId, edit]));
  const hasMethod = has(edits, "paymentMethod");
  let changed = false;

  const nextLines = [];
  for (const line of lines) {
    const id = String(line.employee);
    const next = { ...line };
    if (hasMethod && line.paymentMethod !== edits.paymentMethod) {
      next.paymentMethod = edits.paymentMethod;
      changed = true;
    }
    const edit = editById.get(id);
    if (edit && amountsChanged(line, edit)) {
      const context = contextByEmployee.get(id) || { attendance: [], history: [] };
      const result = validateLineEdit({
        line,
        ref: { sourceType: "bulk", id: bulk._id },
        endDate: bulk.endDate,
        amounts: edit,
        attendance: context.attendance,
        history: context.history,
        employeeName: line.employeeName,
        namePrefix: true,
      });
      if (!result.ok) return result;
      Object.assign(next, result.values);
      changed = true;
    }
    nextLines.push(next);
  }

  if (!changed) return { ok: true, noop: true };
  return { ok: true, noop: false, set: { employees: nextLines, ...recomputeBulkTotals(nextLines) } };
};

module.exports = {
  BULK_EDIT_KEYS,
  BULK_LINE_EDIT_KEYS,
  CHRONOLOGY_CONFLICT,
  SINGLE_EDIT_KEYS,
  VALID_PAYMENT_METHODS,
  findLaterAdvanceConflict,
  getAdvancePosition,
  getBulkChangedEmployeeIds,
  parseBulkEditBody,
  parseSingleEditBody,
  planBulkEdit,
  planSingleEdit,
  recalculateLine,
  recomputeBulkTotals,
  validateLineEdit,
};
