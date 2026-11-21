/*
 * Payout edit rules (utils/payoutEdit.js), no database.
 */
const assert = require("node:assert/strict");
const {
  findLaterAdvanceConflict,
  getAdvancePosition,
  getBulkChangedEmployeeIds,
  parseBulkEditBody,
  parseSingleEditBody,
  planBulkEdit,
  planSingleEdit,
  recalculateLine,
  recomputeBulkTotals,
  VALID_PAYMENT_METHODS,
} = require("../src/utils/payoutEdit");
const { buildPayoutHistoryByEmployee } = require("../src/utils/payoutOverlap");

const EMP = "64b000000000000000000001";
const EMP2 = "64b000000000000000000002";
const utc = (day) => new Date(`${day}T00:00:00.000Z`);

/* ---------- fixtures: one employee, three payouts in order ---------- */
// Advances: 1000 on 10-02, 500 on 10-15, 300 on 11-05.
const attendance = [
  { employee: EMP, date: utc("2026-10-02"), advancePayment: 1000 },
  { employee: EMP, date: utc("2026-10-15"), advancePayment: 500 },
  { employee: EMP, date: utc("2026-11-05"), advancePayment: 300 },
];
const single1 = {
  _id: "single-1", employee: EMP, salarySlipNumber: "NCH-PAY-2026-0001",
  startDate: utc("2026-10-01"), endDate: utc("2026-10-10"),
  grossSalary: 5000, advanceDeducted: 400, deductions: 100,
  outstandingAdvanceBefore: 1000, outstandingAdvanceAfter: 600, netSalary: 4500, paymentMethod: "cash",
};
const bulk2 = {
  _id: "bulk-2", payoutNumber: "NCH-BULK-2026-0002",
  startDate: utc("2026-10-11"), endDate: utc("2026-10-20"), paidOn: utc("2026-10-21"),
  employees: [
    { employee: EMP, employeeName: "Aakib", grossSalary: 4000, advanceDeducted: 600, deductions: 0,
      outstandingAdvanceBefore: 1100, outstandingAdvanceAfter: 500, netSalary: 3400, paymentMethod: "cash" },
    { employee: EMP2, employeeName: "Bilal", grossSalary: 3000, advanceDeducted: 0, deductions: 50,
      outstandingAdvanceBefore: 0, outstandingAdvanceAfter: 0, netSalary: 2950, paymentMethod: "cash" },
  ],
};
const single3 = {
  _id: "single-3", employee: EMP, salarySlipNumber: "NCH-PAY-2026-0003",
  startDate: utc("2026-11-01"), endDate: utc("2026-11-10"),
  grossSalary: 6000, advanceDeducted: 700, deductions: 0, paymentMethod: "upi",
};
const history = buildPayoutHistoryByEmployee([single1, single3], [bulk2]).get(EMP);
const ctx = { attendance, history, employeeName: "Aakib" };

/* 1. Body parsing / immutability */
{
  const forbidden = parseSingleEditBody({ advanceDeducted: 1, grossSalary: 1, startDate: "x" });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.status, 400);
  assert.equal(forbidden.message, "These fields cannot be edited: grossSalary, startDate.");

  for (const key of ["employee", "employeeId", "endDate", "netSalary", "outstandingAdvanceAfter", "paidOn",
    "salarySlipNumber", "totalDaysWorked", "status", "payrollPeriod"]) {
    assert.equal(parseSingleEditBody({ [key]: 1 }).ok, false, `${key} is rejected`);
  }
  assert.equal(parseSingleEditBody({}).status, 400, "empty edit rejected");
  assert.equal(parseSingleEditBody(null).status, 400);
  assert.equal(parseSingleEditBody([]).status, 400);

  assert.equal(parseSingleEditBody({ paymentMethod: "bank_transfer" }).message, "Invalid payment method provided.");
  assert.equal(parseSingleEditBody({ paymentMethod: "" }).ok, false);
  assert.equal(parseSingleEditBody({ paymentMethod: "mixed" }).ok, false);
  VALID_PAYMENT_METHODS.forEach((method) => assert.equal(parseSingleEditBody({ paymentMethod: method }).ok, true));
  assert.deepEqual(VALID_PAYMENT_METHODS, ["cash", "upi", "bank", "cheque"]);

  assert.equal(parseSingleEditBody({ advanceDeducted: -1 }).message, "Advance deduction cannot be negative.");
  assert.equal(parseSingleEditBody({ deductions: -0.5 }).message, "Other deduction cannot be negative.");
  assert.equal(parseSingleEditBody({ advanceDeducted: "abc" }).message, "Advance deduction must be a valid number.");
  assert.equal(parseSingleEditBody({ deductions: Infinity }).ok, false);
  assert.equal(parseSingleEditBody({ deductions: "1e999" }).ok, false);
  assert.equal(parseSingleEditBody({ deductions: { a: 1 } }).ok, false);
  assert.equal(parseSingleEditBody({ deductions: [5] }).ok, false);

  // Rounded to paise before any check; "" and null mean 0 like create.
  assert.deepEqual(parseSingleEditBody({ advanceDeducted: "100.456", deductions: 0.005 }).edits,
    { advanceDeducted: 100.46, deductions: 0.01 });
  assert.deepEqual(parseSingleEditBody({ advanceDeducted: "", deductions: null }).edits,
    { advanceDeducted: 0, deductions: 0 });

  const bulkBad = parseBulkEditBody({ paymentMethod: "cash", totalNetPaid: 5 });
  assert.equal(bulkBad.message, "These fields cannot be edited: totalNetPaid.");
  assert.equal(parseBulkEditBody({ employees: [{ employeeId: EMP, netSalary: 1 }] }).message,
    "Employee edit: These fields cannot be edited: netSalary.");
  assert.equal(parseBulkEditBody({ employees: [{ employeeId: "nope" }] }).status, 400);
  assert.equal(parseBulkEditBody({ employees: [{ employeeId: EMP }, { employeeId: EMP }] }).message,
    "An employee can only appear once in a bulk payout edit.");
  assert.equal(parseBulkEditBody({ employees: "x" }).message, "employees must be an array.");
  assert.equal(parseBulkEditBody({ employees: [] }).status, 400, "nothing to edit");
  assert.equal(parseBulkEditBody({ paymentMethod: "upi", employees: [{ employeeId: EMP, deductions: -1 }] }).ok, false);
  assert.deepEqual(parseBulkEditBody({ paymentMethod: "cheque", employees: [{ employeeId: EMP, advanceDeducted: "1.239" }] }).edits,
    { paymentMethod: "cheque", lines: [{ employeeId: EMP, advanceDeducted: 1.24 }] });
}

/* 2. Recalculation */
{
  assert.deepEqual(recalculateLine({ grossSalary: 5000 }, { advanceDeducted: 250.25, deductions: 99.99, outstandingBefore: 1000 }), {
    advanceDeducted: 250.25, deductions: 99.99,
    outstandingAdvanceBefore: 1000, outstandingAdvanceAfter: 749.75, netSalary: 4649.76,
  });

  const plan = planSingleEdit(single1, { advanceDeducted: 300, deductions: 200, paymentMethod: "bank" }, ctx);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.set, {
    paymentMethod: "bank", advanceDeducted: 300, deductions: 200,
    outstandingAdvanceBefore: 1000, outstandingAdvanceAfter: 700, netSalary: 4500,
  });

  // Only one amount sent: the other keeps its saved value.
  assert.deepEqual(planSingleEdit(single1, { deductions: 0 }, ctx).set, {
    advanceDeducted: 400, deductions: 0,
    outstandingAdvanceBefore: 1000, outstandingAdvanceAfter: 600, netSalary: 4600,
  });

  // Payment method only: no advance recomputation, only the method is written.
  assert.deepEqual(planSingleEdit(single1, { paymentMethod: "upi" }, ctx).set, { paymentMethod: "upi" });
}

/* 3. No-op edits write nothing */
{
  assert.deepEqual(planSingleEdit(single1, { paymentMethod: "cash", advanceDeducted: 400, deductions: 100 }, ctx),
    { ok: true, noop: true });
  assert.deepEqual(planSingleEdit(single1, { advanceDeducted: 400.001 }, ctx), { ok: true, noop: true },
    "equal after paise rounding");
  assert.deepEqual(planBulkEdit(bulk2, { paymentMethod: "cash", lines: [{ employeeId: EMP, advanceDeducted: 600 }] }, new Map()),
    { ok: true, noop: true });
  assert.deepEqual(getBulkChangedEmployeeIds(bulk2, { lines: [{ employeeId: EMP, advanceDeducted: 600 }] }), []);
}

/* 4. Net < 0 rejected with create's message */
{
  const plan = planSingleEdit(single1, { deductions: 4700 }, ctx);
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 400);
  assert.equal(plan.message, "Aakib has deductions greater than gross salary.");
  assert.equal(planSingleEdit(single1, { deductions: 4600 }, ctx).ok, true, "net exactly 0 allowed");
  assert.equal(planSingleEdit(single1, { deductions: 1 }, { ...ctx, employeeName: undefined }).ok, true);
  assert.equal(planSingleEdit(single1, { deductions: 9999 }, { ...ctx, employeeName: undefined }).message,
    "Employee has deductions greater than gross salary.");
}

/* 5. Advance cap at the payout's position */
{
  // single1 (end 10-10): advances up to 10-10 = 1000, no earlier payouts.
  const p1 = getAdvancePosition(attendance, history, { sourceType: "single", id: "single-1" }, single1.endDate);
  assert.deepEqual([p1.advancesTaken, p1.cutsBefore, p1.outstanding], [1000, 0, 1000]);

  // bulk2 (end 10-20): 1500 taken, single1 cut 400 before; own cut excluded; single3 is later.
  const p2 = getAdvancePosition(attendance, history, { sourceType: "bulk", id: "bulk-2" }, bulk2.endDate);
  assert.deepEqual([p2.advancesTaken, p2.cutsBefore, p2.outstanding], [1500, 400, 1100]);

  // single3 (end 11-10): 1800 taken, single1 400 + bulk2 600 before.
  const p3 = getAdvancePosition(attendance, history, { sourceType: "single", id: "single-3" }, single3.endDate);
  assert.equal(p3.outstanding, 800);

  // Same _id in a different source is not "self".
  const wrongSource = getAdvancePosition(attendance, history, { sourceType: "single", id: "bulk-2" }, bulk2.endDate);
  assert.equal(wrongSource.cutsBefore, 1000);

  // Exceeding the cap: same message as create.
  const over = planSingleEdit(single3, { advanceDeducted: 800.01 }, ctx);
  assert.equal(over.status, 400);
  assert.equal(over.message, "Maximum recoverable advance is ₹800");
  assert.equal(planSingleEdit(single3, { advanceDeducted: 800 }, ctx).ok, true);

  // Bulk line message carries the employee name.
  const bulkOver = planBulkEdit(bulk2, { lines: [{ employeeId: EMP, advanceDeducted: 1100.01 }] },
    new Map([[EMP, { attendance, history }]]));
  assert.equal(bulkOver.message, "Aakib: Maximum recoverable advance is ₹1100");

  // Time zone: a bulk end saved at IST local midnight (previous UTC day 18:30)
  // still counts attendance of its calendar end day.
  const istEnd = new Date("2026-10-14T18:30:00.000Z"); // 2026-10-15 00:00 IST
  const tz = getAdvancePosition(attendance, [], { sourceType: "bulk", id: "x" }, istEnd);
  assert.equal(tz.advancesTaken, 1500);
}

/* 6. Chronology conflicts with later payouts */
{
  const ref1 = { sourceType: "single", id: "single-1" };
  // Raising single1 from 400 to 800: bulk2 would have 1500-800=700 < 600? no -> ok;
  // single3 would have 1800-(800+600)=400 < 700 -> conflict.
  const conflict = findLaterAdvanceConflict(attendance, history, ref1, single1.endDate, 800);
  assert.equal(conflict.payout._id, "single-3");
  assert.equal(conflict.recordedAdvanceDeducted, 700);
  assert.equal(conflict.availableAdvance, 400);

  // Raising to 500 keeps single3 exactly covered (1800-1100=700).
  assert.equal(findLaterAdvanceConflict(attendance, history, ref1, single1.endDate, 500), null);

  // First violating later payout is the bulk one when it breaks first.
  const bulkFirst = findLaterAdvanceConflict(attendance, history, ref1, single1.endDate, 1000);
  assert.equal(bulkFirst.payout.overlapSource, "bulk");
  assert.equal(bulkFirst.availableAdvance, 500);

  const plan = planSingleEdit(single1, { advanceDeducted: 800 }, ctx);
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 409);
  assert.equal(plan.code, "ADVANCE_CHRONOLOGY_CONFLICT");
  assert.equal(plan.employeeName, "Aakib");
  assert.equal(plan.conflict.sourceType, "single");
  assert.equal(plan.conflict.payoutId, "single-3");
  assert.equal(plan.conflict.payoutNumber, "NCH-PAY-2026-0003");
  assert.equal(plan.conflict.recordedAdvanceDeducted, 700);
  assert.equal(plan.conflict.availableAdvance, 400);
  assert.match(plan.message, /NCH-PAY-2026-0003/);
  assert.match(plan.message, /2026-11-01 to 2026-11-10/);

  const bulkConflict = planSingleEdit(single1, { advanceDeducted: 1000 }, ctx);
  assert.equal(bulkConflict.conflict.payoutNumber, "NCH-BULK-2026-0002");
  assert.equal(bulkConflict.conflict.payoutId, "bulk-2");
  assert.equal(bulkConflict.conflict.sourceLabel, "Bulk Payout #NCH-BULK-2026-0002");

  // Lowering never conflicts, even when later data is already inconsistent.
  const brokenLater = buildPayoutHistoryByEmployee([single1, { ...single3, advanceDeducted: 5000 }], [bulk2]).get(EMP);
  assert.equal(planSingleEdit(single1, { advanceDeducted: 100 }, { ...ctx, history: brokenLater }).ok, true);
  // ...but raising onto already-broken data is refused.
  assert.equal(planSingleEdit(single1, { advanceDeducted: 401 }, { ...ctx, history: brokenLater }).status, 409);

  // The last payout has nothing later.
  assert.equal(planSingleEdit(single3, { advanceDeducted: 800 }, ctx).ok, true);
}

/* 7. Bulk totals recomputed from edited + untouched lines */
{
  assert.deepEqual(recomputeBulkTotals([
    { grossSalary: 100.1, advanceDeducted: 10, outstandingAdvanceAfter: 5, deductions: 0.2, netSalary: 89.9 },
    { grossSalary: 200.2, advanceDeducted: 0, outstandingAdvanceAfter: 0, deductions: 0.1, netSalary: 200.1 },
  ]), { totalGross: 300.3, totalAdvanceCut: 10, totalAdvanceLeft: 5, totalOtherDeduction: 0.3, totalNetPaid: 290 });

  const contexts = new Map([[EMP, { attendance, history }]]);
  const plan = planBulkEdit(bulk2, {
    paymentMethod: "bank",
    lines: [{ employeeId: EMP, advanceDeducted: 500, deductions: 100 }],
  }, contexts);
  assert.equal(plan.ok, true);
  const [aakib, bilal] = plan.set.employees;
  assert.deepEqual(
    [aakib.advanceDeducted, aakib.deductions, aakib.outstandingAdvanceBefore, aakib.outstandingAdvanceAfter, aakib.netSalary, aakib.paymentMethod],
    [500, 100, 1100, 600, 3400, "bank"]
  );
  assert.equal(aakib.grossSalary, 4000, "gross is untouched");
  assert.equal(aakib.employeeName, "Aakib");
  assert.deepEqual(bilal, { ...bulk2.employees[1], paymentMethod: "bank" }, "unlisted line keeps amounts");
  assert.equal(plan.set.totalGross, 7000);
  assert.equal(plan.set.totalAdvanceCut, 500);
  assert.equal(plan.set.totalAdvanceLeft, 600);
  assert.equal(plan.set.totalOtherDeduction, 150);
  assert.equal(plan.set.totalNetPaid, 6350);
  assert.equal(bulk2.employees[0].advanceDeducted, 600, "input not mutated");

  // Payment method only: lines keep amounts, totals stay equal.
  const methodOnly = planBulkEdit(bulk2, { paymentMethod: "upi", lines: [] }, new Map());
  assert.deepEqual(methodOnly.set.employees.map((line) => line.paymentMethod), ["upi", "upi"]);
  assert.equal(methodOnly.set.totalNetPaid, 6350);

  // Unknown employee -> 400.
  const unknown = planBulkEdit(bulk2, { lines: [{ employeeId: "64b0000000000000000000ff", deductions: 1 }] }, new Map());
  assert.equal(unknown.status, 400);
  assert.match(unknown.message, /not part of this bulk payout/);

  // Net < 0 on a bulk line uses the create message.
  const negative = planBulkEdit(bulk2, { lines: [{ employeeId: EMP2, deductions: 3001 }] },
    new Map([[EMP2, { attendance: [], history: [] }]]));
  assert.equal(negative.message, "Bilal has deductions greater than gross salary.");

  // Raising the bulk line's cut so the later single payout breaks -> 409.
  const later = planBulkEdit(bulk2, { lines: [{ employeeId: EMP, advanceDeducted: 1000 }] }, contexts);
  assert.equal(later.status, 409);
  assert.equal(later.conflict.payoutNumber, "NCH-PAY-2026-0003");

  assert.deepEqual(getBulkChangedEmployeeIds(bulk2, { lines: [{ employeeId: EMP, deductions: 1 }, { employeeId: EMP2, deductions: 50 }] }), [EMP]);
}

console.log("payout-edit tests passed");
