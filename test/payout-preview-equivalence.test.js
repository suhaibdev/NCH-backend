/*
 * Payout preview equivalence (no MongoDB).
 *
 * POST /payout/preview and POST /payout/bulk-preview used to load all attendance
 * and payout history. They now load only the period's attendance, sum advances
 * per employee and read overlapping payouts. This test keeps a frozen copy of the
 * OLD algorithm (full arrays through the same shared helpers) and checks that the
 * real new route handlers return byte-identical JSON on many random datasets.
 *
 * The fake models implement only the Mongo operators the new code uses, so the
 * real aggregation pipelines still need one live-MongoDB comparison (see report).
 */
const assert = require("node:assert/strict");
const path = require("path");
const mongoose = require("mongoose");
const { startOfDay } = require("date-fns");

const root = path.join(__dirname, "..");
const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(root, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

/* ---------------- tiny Mongo operator evaluator ---------------- */

const sameValue = (a, b) => {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  return String(a) === String(b);
};
const asTime = (v) => (v instanceof Date ? v.getTime() : v);

// Values at a (possibly array-traversing) path such as "employees.employee".
const valuesAt = (doc, field) =>
  field.split(".").reduce(
    (current, key) =>
      current.flatMap((item) => {
        if (item === undefined || item === null) return [];
        const value = item[key];
        return Array.isArray(value) ? value : [value];
      }),
    [doc]
  );

const matchCondition = (values, condition) => {
  const isOps =
    condition && typeof condition === "object" && !(condition instanceof Date) &&
    !(condition instanceof mongoose.Types.ObjectId) &&
    Object.keys(condition).some((key) => key.startsWith("$"));
  if (!isOps) return values.some((value) => sameValue(value, condition));
  return Object.entries(condition).every(([op, operand]) =>
    values.some((value) => {
      if (value === undefined || value === null) return false;
      if (op === "$in") return operand.some((candidate) => sameValue(value, candidate));
      if (op === "$lte") return asTime(value) <= asTime(operand);
      if (op === "$gte") return asTime(value) >= asTime(operand);
      if (op === "$gt") return asTime(value) > asTime(operand);
      throw new Error(`unsupported operator ${op}`);
    })
  );
};

const matches = (doc, filter) =>
  Object.entries(filter).every(([field, condition]) => matchCondition(valuesAt(doc, field), condition));

const resolvePath = (doc, expression) => valuesAt(doc, expression.slice(1))[0];

const runPipeline = (docs, pipeline) => {
  let rows = docs.map((doc) => ({ ...doc }));
  pipeline.forEach((stage) => {
    const [name, spec] = Object.entries(stage)[0];
    if (name === "$match") {
      rows = rows.filter((row) => matches(row, spec));
    } else if (name === "$unwind") {
      const field = spec.slice(1);
      rows = rows.flatMap((row) => (row[field] || []).map((item) => ({ ...row, [field]: item })));
    } else if (name === "$sort") {
      rows = [...rows].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    } else if (name === "$group") {
      const groups = new Map();
      rows.forEach((row) => {
        const key = String(resolvePath(row, spec._id));
        if (!groups.has(key)) groups.set(key, { _id: resolvePath(row, spec._id), total: 0 });
        const group = groups.get(key);
        const value = resolvePath(row, spec.total.$sum);
        if (typeof value === "number") group.total += value;
      });
      rows = [...groups.values()];
    } else if (name === "$project") {
      rows = rows.map((row) => {
        const out = {};
        Object.entries(spec).forEach(([key, value]) => {
          if (value === 1) out[key] = row[key];
          else if (value.$filter) {
            const ids = value.$filter.cond.$in[1];
            out[key] = row[key].filter((line) => ids.some((id) => sameValue(line.employee, id)));
          } else throw new Error("unsupported $project");
        });
        return { _id: row._id, ...out };
      });
    } else {
      throw new Error(`unsupported stage ${name}`);
    }
  });
  return rows;
};

/* ---------------- fake models over a mutable dataset ---------------- */

let data = { employees: [], attendance: [], payouts: [], bulk: [] };
const sessionStarts = { count: 0 };
mongoose.startSession = async () => {
  sessionStarts.count += 1;
  throw new Error("previews must not open a session");
};

const query = (produce) => {
  const q = {
    select: () => q,
    sort: () => q,
    lean: () => q,
    then: (resolve, reject) => Promise.resolve().then(produce).then(resolve, reject),
  };
  return q;
};

stub("src/models/Employee", {
  findById: (id) => query(() => data.employees.find((e) => String(e._id) === String(id)) || null),
  find: (filter) =>
    query(() =>
      data.employees
        .filter((e) => matches(e, filter))
        .sort((a, b) => a.name.localeCompare(b.name))
    ),
});
stub("src/models/Attendance", {
  find: (filter) => query(() => data.attendance.filter((r) => matches(r, filter))),
  aggregate: async (pipeline) => runPipeline(data.attendance, pipeline),
});
stub("src/models/Payout", {
  find: (filter) => query(() => data.payouts.filter((r) => matches(r, filter))),
  aggregate: async (pipeline) => runPipeline(data.payouts, pipeline),
});
stub("src/models/BulkPayout", {
  find: (filter) => query(() => data.bulk.filter((r) => matches(r, filter))),
  aggregate: async (pipeline) => runPipeline(data.bulk, pipeline),
});
stub("src/models/PayoutCounter", {});

const router = require("../src/routes/payout");
const handlerFor = (routePath) =>
  router.stack.find((layer) => layer.route && layer.route.path === routePath && layer.route.methods.post)
    .route.stack[0].handle;
const singlePreview = handlerFor("/preview");
const bulkPreview = handlerFor("/bulk-preview");

const call = async (handler, body) => {
  const result = { status: 200, body: undefined };
  const res = {
    status(code) {
      result.status = code;
      return res;
    },
    json(payload) {
      result.body = JSON.parse(JSON.stringify(payload));
      return res;
    },
  };
  await handler({ body }, res);
  return result;
};

/* ---------------- frozen reference (the OLD algorithm) ---------------- */

const {
  STANDARD_WORK_HOURS,
  calculateAdvanceStatus,
  getWorkingTime,
  isPresentByWorkHours,
} = require("../src/utils/payroll");
const {
  buildPayoutHistoryByEmployee,
  filterPayoutsEndingBy,
  findOverlappingPayout,
  getOverlapDetails,
} = require("../src/utils/payoutOverlap");

const roundCurrency = (value) => Math.round(value * 100) / 100;

const refMetrics = (attendance, start, end, hourlyRate) => {
  const period = attendance.filter((item) => {
    const workHours = Number(item.workHours || 0);
    const overtime = item.overtime || 0;
    const isValid = workHours >= 0 && workHours <= 24 && overtime >= 0 && overtime <= 24;
    return isPresentByWorkHours(workHours) && isValid && item.date >= start && item.date <= end;
  });
  const totalHoursWorked = period.reduce((sum, item) => sum + Number(item.workHours || 0), 0);
  const workingTime = getWorkingTime(totalHoursWorked);
  const overtimeHours = period.reduce((sum, item) => sum + (item.overtime || 0), 0);
  const baseSalary = roundCurrency(totalHoursWorked * hourlyRate);
  const overtimeAmount = roundCurrency(overtimeHours * hourlyRate);
  return {
    totalDaysWorked: workingTime.fullWorkingDays,
    totalHoursWorked,
    overtimeHours,
    baseSalary,
    overtimeAmount,
    grossSalary: roundCurrency(baseSalary + overtimeAmount),
    workingTime,
  };
};

const refRange = (startDate, endDate) => ({
  start: startOfDay(new Date(startDate)),
  end: startOfDay(new Date(endDate)),
});

const refSingle = ({ employeeId, startDate, endDate }) => {
  const { start, end } = refRange(startDate, endDate);
  const employee = data.employees.find((e) => String(e._id) === String(employeeId));
  const allAttendance = data.attendance.filter(
    (r) => String(r.employee) === String(employeeId) && r.date <= end
  );
  const legacy = data.payouts.filter((r) => String(r.employee) === String(employeeId));
  const bulk = data.bulk.filter((b) => b.employees.some((l) => String(l.employee) === String(employeeId)));
  const history = buildPayoutHistoryByEmployee(legacy, bulk).get(String(employeeId)) || [];
  const previous = filterPayoutsEndingBy(history, end);
  const hourlyRate = roundCurrency(employee.baseDailySalary / STANDARD_WORK_HOURS);
  const payroll = refMetrics(allAttendance, start, end, hourlyRate);
  const advance = calculateAdvanceStatus(allAttendance, previous);
  return {
    employeeId: String(employeeId),
    employeeName: employee.name,
    dailySalary: employee.baseDailySalary,
    hourlyRate,
    startDate,
    endDate,
    totalDaysWorked: payroll.totalDaysWorked,
    totalHoursWorked: payroll.totalHoursWorked,
    fullWorkingDays: payroll.workingTime.fullWorkingDays,
    remainingWorkingHours: payroll.workingTime.remainingWorkingHours,
    workingTime: payroll.workingTime,
    overtimeHours: payroll.overtimeHours,
    overtimeAmount: payroll.overtimeAmount,
    baseSalary: payroll.baseSalary,
    grossSalary: payroll.grossSalary,
    estimatedNetSalary: payroll.grossSalary,
    totalAdvanceTaken: advance.totalAdvanceTaken,
    advanceAlreadyRecovered: advance.advanceRecovered,
    remainingAdvance: advance.remainingAdvance,
  };
};

const emptySummary = {
  totalEmployees: 0,
  selectedByDefault: 0,
  alreadyCreated: 0,
  zeroSalary: 0,
  totalGrossSalary: 0,
  totalNetSalary: 0,
};

const refBulk = ({ startDate, endDate }) => {
  const { start, end } = refRange(startDate, endDate);
  const inPeriod = data.attendance.filter((r) => r.date >= start && r.date <= end);
  if (inPeriod.length === 0) return { startDate, endDate, employees: [], summary: { ...emptySummary } };
  const ids = [...new Set(inPeriod.map((r) => String(r.employee)))];
  const employees = data.employees
    .filter((e) => ids.includes(String(e._id)) && e.isActive)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (employees.length === 0) return { startDate, endDate, employees: [], summary: { ...emptySummary } };
  const activeIds = employees.map((e) => String(e._id));
  const historical = data.attendance.filter(
    (r) => activeIds.includes(String(r.employee)) && r.date <= end
  );
  const legacy = data.payouts.filter((r) => activeIds.includes(String(r.employee)));
  const bulk = data.bulk.filter((b) => b.employees.some((l) => activeIds.includes(String(l.employee))));
  const payoutsByEmployee = buildPayoutHistoryByEmployee(legacy, bulk);

  const rows = employees.map((employee) => {
    const id = String(employee._id);
    const attendance = historical.filter((r) => String(r.employee) === id);
    const payouts = payoutsByEmployee.get(id) || [];
    const marked = attendance.filter((r) => r.date >= start && r.date <= end);
    const hourlyRate = roundCurrency(employee.baseDailySalary / STANDARD_WORK_HOURS);
    const payroll = refMetrics(attendance, start, end, hourlyRate);
    const previous = payouts.filter((p) => p.endDate && new Date(p.endDate) <= end);
    const advance = calculateAdvanceStatus(attendance, previous);
    const overlapping = findOverlappingPayout(payouts, start, end);
    const alreadyCreated = Boolean(overlapping);
    return {
      employeeId: employee._id,
      employeeName: employee.name,
      dailySalary: employee.baseDailySalary,
      hourlyRate,
      attendanceMarked: marked.length,
      totalDaysWorked: payroll.totalDaysWorked,
      totalHoursWorked: payroll.totalHoursWorked,
      fullWorkingDays: payroll.workingTime.fullWorkingDays,
      remainingWorkingHours: payroll.workingTime.remainingWorkingHours,
      workingTime: payroll.workingTime,
      overtimeHours: payroll.overtimeHours,
      overtimeAmount: payroll.overtimeAmount,
      baseSalary: payroll.baseSalary,
      grossSalary: payroll.grossSalary,
      totalAdvanceTaken: advance.totalAdvanceTaken,
      advanceAlreadyRecovered: advance.advanceRecovered,
      remainingAdvance: advance.remainingAdvance,
      advanceDeducted: 0,
      otherDeduction: 0,
      netSalary: payroll.grossSalary,
      selectable: !alreadyCreated,
      selectedByDefault: !alreadyCreated && payroll.grossSalary > 0,
      zeroSalary: payroll.grossSalary <= 0,
      alreadyCreated,
      existingPayout: getOverlapDetails(overlapping),
    };
  });
  const summary = rows.reduce(
    (result, row) => {
      result.totalEmployees += 1;
      result.totalGrossSalary += row.grossSalary;
      result.totalNetSalary += row.netSalary;
      if (row.selectedByDefault) result.selectedByDefault += 1;
      if (row.alreadyCreated) result.alreadyCreated += 1;
      if (row.zeroSalary) result.zeroSalary += 1;
      return result;
    },
    { ...emptySummary }
  );
  summary.totalGrossSalary = roundCurrency(summary.totalGrossSalary);
  summary.totalNetSalary = roundCurrency(summary.totalNetSalary);
  return { startDate, endDate, employees: rows, summary };
};

/* ---------------- seeded random datasets ---------------- */

const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2025, 0, 1);
const dayDate = (n) => new Date(BASE + n * DAY);
const dayString = (n) => dayDate(n).toISOString().slice(0, 10);
const oid = () => new mongoose.Types.ObjectId();

const buildDataset = (rand) => {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const employees = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => ({
    _id: oid(),
    name: `Emp ${String.fromCharCode(65 + i)}${Math.floor(rand() * 90)}`,
    baseDailySalary: pick([400, 450, 500, 640, 800, 833.33]),
    isActive: rand() > 0.2,
  }));
  const attendance = [];
  employees.forEach((employee) => {
    for (let day = 0; day < 90; day += 1) {
      if (rand() < 0.35) continue;
      attendance.push({
        _id: oid(),
        employee: employee._id,
        date: dayDate(day),
        present: true,
        workHours: pick([0, 0, 4, 7.5, 8, 8, 8, 30, -1]),
        overtime: pick([0, 0, 0, 1, 2.5, 30]),
        advancePayment: pick([0, 0, 0, 0, 100, 250.5, 500]),
      });
    }
  });
  // Payout boundaries: UTC midnight (single) or server-local style (18:30Z) like bulk.
  const boundary = (n) => (rand() < 0.5 ? dayDate(n) : new Date(dayDate(n).getTime() - 5.5 * 3600 * 1000));
  const payouts = [];
  const bulk = [];
  employees.forEach((employee) => {
    for (let i = 0; i < Math.floor(rand() * 3); i += 1) {
      const startDay = Math.floor(rand() * 70);
      payouts.push({
        _id: oid(),
        employee: employee._id,
        startDate: boundary(startDay),
        endDate: boundary(startDay + Math.floor(rand() * 15)),
        paidOn: dayDate(startDay + 16),
        salarySlipNumber: `NCH-PAY-2025-${Math.floor(rand() * 9999)}`,
        advanceDeducted: pick([0, 50, 100, 120.25]),
      });
    }
  });
  for (let i = 0; i < Math.floor(rand() * 3); i += 1) {
    const startDay = Math.floor(rand() * 70);
    const lines = employees
      .filter(() => rand() < 0.6)
      .map((employee) => ({
        employee: employee._id,
        employeeName: employee.name,
        advanceDeducted: pick([0, 30, 100, 75.75]),
        netSalary: 1000,
      }));
    if (lines.length === 0) continue;
    bulk.push({
      _id: oid(),
      payoutNumber: `NCH-BULK-2025-${String(i + 1).padStart(4, "0")}`,
      startDate: boundary(startDay),
      endDate: boundary(startDay + Math.floor(rand() * 15)),
      paidOn: dayDate(startDay + 16),
      employees: lines,
    });
  }
  return { employees, attendance, payouts, bulk };
};

(async () => {
  let comparedSingle = 0;
  let comparedBulk = 0;
  let overlapCases = 0;
  let nonEmptyAdvance = 0;

  for (let seed = 1; seed <= 250; seed += 1) {
    const rand = mulberry32(seed);
    data = buildDataset(rand);
    const startDay = Math.floor(rand() * 60);
    const endDay = startDay + Math.floor(rand() * 25);
    const body = { startDate: dayString(startDay), endDate: dayString(endDay) };

    // Bulk preview.
    const bulkResult = await call(bulkPreview, body);
    assert.equal(bulkResult.status, 200, `bulk status (seed ${seed})`);
    assert.deepEqual(bulkResult.body, JSON.parse(JSON.stringify(refBulk(body))), `bulk preview (seed ${seed})`);
    comparedBulk += 1;
    overlapCases += bulkResult.body.employees.filter((e) => e.alreadyCreated).length;
    nonEmptyAdvance += bulkResult.body.employees.filter((e) => e.totalAdvanceTaken > 0).length;

    // Single preview for every active employee.
    for (const employee of data.employees.filter((e) => e.isActive)) {
      const single = { employeeId: String(employee._id), ...body };
      const result = await call(singlePreview, single);
      assert.equal(result.status, 200, `single status (seed ${seed})`);
      assert.deepEqual(result.body, JSON.parse(JSON.stringify(refSingle(single))), `single preview (seed ${seed})`);
      comparedSingle += 1;
    }
  }

  assert.equal(sessionStarts.count, 0, "previews never open a session");
  assert.ok(comparedBulk === 250 && comparedSingle > 250, "datasets were compared");
  assert.ok(overlapCases > 20, "overlap branch exercised");
  assert.ok(nonEmptyAdvance > 100, "advance branch exercised");

  // Hand-made boundaries: payout ending exactly on start-1 (no overlap) and on start (overlap);
  // advance recovered only counts payouts ending on or before the end date.
  data = { employees: [], attendance: [], payouts: [], bulk: [] };
  const employee = { _id: oid(), name: "Edge", baseDailySalary: 800, isActive: true };
  data.employees.push(employee);
  for (let day = 0; day < 40; day += 1) {
    data.attendance.push({
      _id: oid(), employee: employee._id, date: dayDate(day), workHours: 8, overtime: 0,
      advancePayment: day === 3 ? 1000 : 0,
    });
  }
  data.payouts.push({
    _id: oid(), employee: employee._id, startDate: dayDate(0), endDate: dayDate(9),
    paidOn: dayDate(10), salarySlipNumber: "S1", advanceDeducted: 400,
  });
  data.payouts.push({
    _id: oid(), employee: employee._id, startDate: dayDate(30), endDate: dayDate(39),
    paidOn: dayDate(40), salarySlipNumber: "S2", advanceDeducted: 500,
  });
  const edge = { startDate: dayString(10), endDate: dayString(20) };
  const edgeBulk = await call(bulkPreview, edge);
  assert.deepEqual(edgeBulk.body, JSON.parse(JSON.stringify(refBulk(edge))));
  assert.equal(edgeBulk.body.employees[0].alreadyCreated, false, "payout ending on start-1 does not overlap");
  assert.equal(edgeBulk.body.employees[0].remainingAdvance, 600, "later payout is not recovered yet");
  const edgeOverlap = { startDate: dayString(9), endDate: dayString(20) };
  const overlapBulk = await call(bulkPreview, edgeOverlap);
  assert.deepEqual(overlapBulk.body, JSON.parse(JSON.stringify(refBulk(edgeOverlap))));
  assert.equal(overlapBulk.body.employees[0].alreadyCreated, true, "payout ending on start overlaps");

  // Validation errors are unchanged.
  assert.equal((await call(singlePreview, { employeeId: "bad", startDate: "2025-01-01", endDate: "2025-01-02" })).status, 400);
  assert.equal((await call(bulkPreview, { startDate: "2025-02-01", endDate: "2025-01-01" })).status, 400);

  console.log(
    `Payout preview equivalence: ${comparedBulk} bulk and ${comparedSingle} single previews identical to the old algorithm.`
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
