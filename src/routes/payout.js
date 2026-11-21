const express = require('express');
const router = express.Router();
const Payout = require('../models/Payout');
const BulkPayout = require('../models/BulkPayout');
const { startOfDay, endOfDay } = require('date-fns');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const PayoutCounter = require('../models/PayoutCounter');
const {
  buildPayoutHistoryByEmployee,
  filterPayoutsEndingBy,
  findOverlappingPayout,
  getOverlapDetails,
} = require('../utils/payoutOverlap');
const { getHistoryPagination, serializeBulkHistoryItem } = require('../utils/payoutHistory');
const {
  STANDARD_WORK_HOURS,
  calculateAdvanceStatus,
  calculateNetSalary,
  getWorkingTime,
  isPresentByWorkHours,
  validateNetSalary,
} = require('../utils/payroll');
const payoutEdit = require('../utils/payoutEdit');
const { sendServerError } = require('../utils/httpErrors');

// ===============================================
// HELPER FUNCTIONS
// ===============================================

/**
 * Normalizes a date to the start of its day in UTC.
 * This prevents timezone-related bugs in date comparisons.
 * @param {string | Date} value - The date to normalize.
 * @returns {Date | null} The normalized Date object or null if invalid.
 */
const parseDate = (value) => {
  // Using startOfDay from date-fns normalizes the date to the beginning of the day,
  // which is crucial for creating reliable date-range queries that are not affected by timezones.
  const date = startOfDay(new Date(value));
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

/** Rounds a numeric value to two decimal places for currency. */
const roundCurrency = (value) => Math.round(value * 100) / 100;

const validatePayrollRange = (startDate, endDate) => {
  const start = parseDate(startDate);
  const end = parseDate(endDate);

  if (!start || !end) {
    return { valid: false, status: 400, message: 'Start date and end date are required.' };
  }

  if (start > end) {
    return {
      valid: false,
      status: 400,
      message: 'Start date cannot be after end date.',
    };
  }

  // Use endOfDay to ensure the comparison includes the entire current day.
  const today = endOfDay(new Date());
  if (end > today) {
    return { valid: false, status: 400, message: 'Future dates are not allowed.' };
  }

  return {
    valid: true,
    start,
    end,
  };
};

/**
 * Calculates payroll metrics for a given period from attendance records.
 * @returns {object} An object containing payroll metrics.
 */
const calculatePayrollMetrics = (attendance, start, end, hourlyRate) => {
  const periodAttendance = attendance.filter((item) => {
    const workHours = Number(item.workHours || 0);
    const overtime = item.overtime || 0;
    // Validate attendance records to prevent corrupt data from affecting payroll.
    const isValid = workHours >= 0 && workHours <= 24 && overtime >= 0 && overtime <= 24;

    // Compare dates directly after normalization.
    // Work hours are authoritative. This also makes legacy zero-hour records
    // absent even if they were saved with a stale `present: true` flag.
    return isPresentByWorkHours(workHours) && isValid && item.date >= start && item.date <= end;
  });

  const totalHoursWorked = periodAttendance.reduce(
    (sum, item) => sum + Number(item.workHours || 0),
    0
  );
  const workingTime = getWorkingTime(totalHoursWorked);
  const totalDaysWorked = workingTime.fullWorkingDays;
  const overtimeHours = periodAttendance.reduce(
    (sum, item) => sum + (item.overtime || 0),
    0
  );
  const baseSalary = roundCurrency(totalHoursWorked * hourlyRate);
  const overtimeAmount = roundCurrency(overtimeHours * hourlyRate);
  const grossSalary = roundCurrency(baseSalary + overtimeAmount);

  return {
    totalDaysWorked,
    totalHoursWorked,
    overtimeHours,
    baseSalary,
    overtimeAmount,
    grossSalary,
    workingTime,
  };
};

/**
 * Loads one employee's payout history from BOTH single Payout records and
 * BulkPayout employee lines (same sources the bulk payout flow uses).
 */
const loadEmployeePayoutHistory = async (employeeId, session = null) => {
  const objectId = new mongoose.Types.ObjectId(String(employeeId));
  const withSession = (query) => (session ? query.session(session) : query);
  const payoutQuery = () => withSession(Payout.find({ employee: objectId }).lean());
  const bulkQuery = () => withSession(BulkPayout.find({ 'employees.employee': objectId }).lean());
  // A session must never run two operations at once (MongoDB transactions do not
  // support parallel operations), so session reads run one after the other.
  const [legacyPayouts, bulkPayouts] = session
    ? [await payoutQuery(), await bulkQuery()]
    : await Promise.all([payoutQuery(), bulkQuery()]);
  return buildPayoutHistoryByEmployee(legacyPayouts, bulkPayouts).get(String(employeeId)) || [];
};

// ===============================================
// BULK PAYOUT HELPERS
// ===============================================

// Shared with the payout edit rules (cash, upi, bank, cheque).
const { VALID_PAYMENT_METHODS } = payoutEdit;

/**
 * Groups mongoose records by employee ID.
 */
const groupByEmployee = (records) => {
  const grouped = new Map();

  records.forEach((record) => {
    const employeeId =
      record.employee?._id?.toString?.() ||
      record.employee?.toString?.();

    if (!employeeId) {
      return;
    }

    if (!grouped.has(employeeId)) {
      grouped.set(employeeId, []);
    }

    grouped.get(employeeId).push(record);
  });

  return grouped;
};

/**
 * Salary slip number generator.
 */
const generatePayoutNumber = async (session = null) => {
  const year = new Date().getFullYear();

  const options = {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  };

  if (session) {
    options.session = session;
  }

  const counter = await PayoutCounter.findOneAndUpdate(
    {
      _id: `payout-${year}`,
    },
    {
      $inc: {
        sequence: 1,
      },
    },
    options
  );

  const sequence = String(
    counter.sequence
  ).padStart(4, "0");

  return `NCH-PAY-${year}-${sequence}`;
};

const generateBulkPayoutNumber = async (session) => {
  const year = new Date().getFullYear();
  const counter = await PayoutCounter.findOneAndUpdate(
    { _id: `bulk-payout-${year}` },
    { $inc: { sequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );

  return `NCH-BULK-${year}-${String(counter.sequence).padStart(4, '0')}`;
};

// ===============================================
// GET ALL PAYOUTS
// ===============================================
router.get('/', async (req, res) => {
  try {
    const payouts = await Payout.find() // Intentionally not using .lean() here as populate() is used.
      .populate(
        'employee',
        'name workType baseDailySalary'
      )
      .sort({ paidOn: -1 });
    res.json(payouts);
  } catch (err) {
    sendServerError(res, 'GET PAYOUTS', err);
  }
});

router.get('/bulk-history', async (req, res) => {
  try {
    const { page, limit } = getHistoryPagination(req.query);
    const [items, total] = await Promise.all([
      BulkPayout.find().sort({ paidOn: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      BulkPayout.countDocuments(),
    ]);
    const safeItems = items.map(serializeBulkHistoryItem);
    res.json({ items: safeItems, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: 'Unable to load bulk payout history.' });
  }
});

router.get('/single-history', async (req, res) => {
  try {
    const { page, limit } = getHistoryPagination(req.query);
    const [items, total] = await Promise.all([
      Payout.find()
        .select('employee startDate endDate netSalary paidOn paymentMethod status totalDaysWorked totalHoursWorked fullWorkingDays remainingWorkingHours grossSalary outstandingAdvanceAfter advanceDeducted deductions')
        .populate('employee', 'name')
        .sort({ paidOn: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Payout.countDocuments(),
    ]);
    res.json({ items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: 'Unable to load single payout history.' });
  }
});

// ===============================================
// GET PAYOUTS OF SINGLE EMPLOYEE
// ===============================================
router.get('/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ message: 'Invalid Employee ID format.' });
    }

    const payouts = await Payout.find({
      employee: employeeId,
    })
      .populate(
        'employee',
        'name workType baseDailySalary'
      )
      .sort({
        paidOn: -1
      })
      .lean(); // Using .lean() here is a good optimization as it's a read-only operation.
    res.json(payouts);
  } catch (err) {
    sendServerError(res, 'GET EMPLOYEE PAYOUTS', err);
  }
});

// ===============================================
// PAYOUT PREVIEW
// ===============================================
router.post('/preview', async (req, res) => {
  try {
    const { employeeId, startDate, endDate } = req.body;
    
    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ message: 'Invalid Employee ID format.' });
    }
    
    if (!employeeId || !startDate || !endDate) {
      return res.status(400).json({ message: 'Employee and date range are required.' });
    }

    const range = validatePayrollRange(startDate, endDate);
    if (!range.valid) {
      return res.status(range.status).json({
        message: range.message,
      });
    }

    const employee = await Employee.findById(employeeId).lean();
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found.' });
    }
    if (!employee.isActive) {
      return res.status(400).json({ message: 'Cannot process payroll for an inactive employee.' });
    }

    // Advance recoveries come from BOTH single payouts and bulk payout lines.
    const [allAttendance, payoutHistory] = await Promise.all([
      Attendance.find({ employee: employeeId, date: { $lte: range.end } }).lean(),
      loadEmployeePayoutHistory(employeeId),
    ]);
    const previousPayouts = filterPayoutsEndingBy(payoutHistory, range.end);

    const hourlyRate = roundCurrency(employee.baseDailySalary / STANDARD_WORK_HOURS);
    const payroll = calculatePayrollMetrics(
      allAttendance,
      range.start,
      range.end,
      hourlyRate
    );

    const advanceStatus = calculateAdvanceStatus(allAttendance, previousPayouts);

    res.json({
      employeeId,
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
      // Renamed to `estimatedNetSalary` to avoid confusion. The preview does not account for deductions.
      estimatedNetSalary: payroll.grossSalary,
      totalAdvanceTaken: advanceStatus.totalAdvanceTaken,
      advanceAlreadyRecovered: advanceStatus.advanceRecovered,
      remainingAdvance: advanceStatus.remainingAdvance,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: 'Failed to generate preview.',
    });
  }
});

// ===============================================
// BULK PAYOUT PREVIEW
// ===============================================

router.post('/bulk-preview', async (req, res) => {
  try {
    const {
      startDate,
      endDate,
    } = req.body;

    const range = validatePayrollRange(
      startDate,
      endDate
    );

    if (!range.valid) {
      return res
        .status(range.status)
        .json({
          message: range.message,
        });
    }

    /*
     * First find attendance records INSIDE
     * the requested payroll period.
     *
     * This guarantees that only employees who
     * actually have attendance marked during
     * this period enter the bulk preview.
     *
     * Both Present and Absent records count as
     * "attendance marked".
     */
    const attendanceInPeriod =
      await Attendance.find({
        date: {
          $gte: range.start,
          $lte: range.end,
        },
      }).lean();

    if (attendanceInPeriod.length === 0) {
      return res.json({
        startDate,
        endDate,
        employees: [],
        summary: {
          totalEmployees: 0,
          selectedByDefault: 0,
          alreadyCreated: 0,
          zeroSalary: 0,
          totalGrossSalary: 0,
          totalNetSalary: 0,
        },
      });
    }

    /*
     * Collect unique employee IDs that have at
     * least one marked attendance record.
     */
    const employeeIds = [
      ...new Set(
        attendanceInPeriod
          .map((record) =>
            record.employee?.toString()
          )
          .filter(Boolean)
      ),
    ];

    /*
     * Only ACTIVE employees are allowed.
     */
    const employees = await Employee.find({
      _id: {
        $in: employeeIds,
      },
      isActive: true,
    })
      .sort({
        name: 1,
      })
      .lean();

    if (employees.length === 0) {
      return res.json({
        startDate,
        endDate,
        employees: [],
        summary: {
          totalEmployees: 0,
          selectedByDefault: 0,
          alreadyCreated: 0,
          zeroSalary: 0,
          totalGrossSalary: 0,
          totalNetSalary: 0,
        },
      });
    }

    const activeEmployeeIds =
      employees.map(
        (employee) => employee._id
      );

    /*
     * We need historical attendance up to the
     * payroll end date because advances may have
     * been taken before this payroll period.
     */
    const [
      historicalAttendance,
      legacyPayouts,
      bulkPayouts,
    ] = await Promise.all([
      Attendance.find({
        employee: {
          $in: activeEmployeeIds,
        },
        date: {
          $lte: range.end,
        },
      }).lean(),

      Payout.find({
        employee: {
          $in: activeEmployeeIds,
        },
      }).lean(),

      BulkPayout.find({
        'employees.employee': {
          $in: activeEmployeeIds,
        },
      }).lean(),
    ]);

    const attendanceByEmployee =
      groupByEmployee(
        historicalAttendance
      );

    const payoutsByEmployee =
      buildPayoutHistoryByEmployee(
        legacyPayouts,
        bulkPayouts
      );

    const previewEmployees =
      employees.map((employee) => {
        const id =
          employee._id.toString();

        const employeeAttendance =
          attendanceByEmployee.get(id) ||
          [];

        const employeePayouts =
          payoutsByEmployee.get(id) ||
          [];

        /*
         * Count every marked attendance record,
         * including absent records.
         */
        const markedAttendance =
          employeeAttendance.filter(
            (record) =>
              record.date >=
                range.start &&
              record.date <=
                range.end
          );

        const hourlyRate =
          roundCurrency(
            employee.baseDailySalary /
              STANDARD_WORK_HOURS
          );

        const payroll =
          calculatePayrollMetrics(
            employeeAttendance,
            range.start,
            range.end,
            hourlyRate
          );

        /*
         * Only older/equal payroll periods should
         * affect the employee's advance balance.
         */
        const previousPayouts =
          employeePayouts.filter(
            (payout) => {
              if (!payout.endDate) {
                return false;
              }

              return (
                new Date(
                  payout.endDate
                ) <= range.end
              );
            }
          );

        const advanceStatus =
          calculateAdvanceStatus(
            employeeAttendance,
            previousPayouts
          );

        /*
         * Detect exact OR partially overlapping
         * payout periods.
         */
        const overlappingPayout =
          findOverlappingPayout(
            employeePayouts,
            range.start,
            range.end
          );

        const alreadyCreated =
          Boolean(overlappingPayout);

        /*
         * Employees with ₹0 gross salary are shown,
         * but NOT selected automatically.
         *
         * Employees with existing/overlapping
         * payouts are locked completely.
         */
        const selectedByDefault =
          !alreadyCreated &&
          payroll.grossSalary > 0;

        return {
          employeeId:
            employee._id,

          employeeName:
            employee.name,

          dailySalary:
            employee.baseDailySalary,

          hourlyRate,

          attendanceMarked:
            markedAttendance.length,

          totalDaysWorked:
            payroll.totalDaysWorked,

          totalHoursWorked:
            payroll.totalHoursWorked,

          fullWorkingDays:
            payroll.workingTime.fullWorkingDays,

          remainingWorkingHours:
            payroll.workingTime.remainingWorkingHours,

          workingTime:
            payroll.workingTime,

          overtimeHours:
            payroll.overtimeHours,

          overtimeAmount:
            payroll.overtimeAmount,

          baseSalary:
            payroll.baseSalary,

          grossSalary:
            payroll.grossSalary,

          totalAdvanceTaken:
            advanceStatus.totalAdvanceTaken,

          advanceAlreadyRecovered:
            advanceStatus.advanceRecovered,

          remainingAdvance:
            advanceStatus.remainingAdvance,

          advanceDeducted: 0,

          otherDeduction: 0,

          netSalary:
            payroll.grossSalary,

          selectable:
            !alreadyCreated,

          selectedByDefault,

          zeroSalary:
            payroll.grossSalary <= 0,

          alreadyCreated,

          existingPayout:
            getOverlapDetails(
              overlappingPayout
            ),
        };
      });

    const summary =
      previewEmployees.reduce(
        (result, employee) => {
          result.totalEmployees += 1;

          result.totalGrossSalary +=
            employee.grossSalary;

          /*
           * Initial Net is same as Gross because
           * bulk advance deduction defaults to 0.
           */
          result.totalNetSalary +=
            employee.netSalary;

          if (
            employee.selectedByDefault
          ) {
            result.selectedByDefault +=
              1;
          }

          if (
            employee.alreadyCreated
          ) {
            result.alreadyCreated += 1;
          }

          if (employee.zeroSalary) {
            result.zeroSalary += 1;
          }

          return result;
        },
        {
          totalEmployees: 0,
          selectedByDefault: 0,
          alreadyCreated: 0,
          zeroSalary: 0,
          totalGrossSalary: 0,
          totalNetSalary: 0,
        }
      );

    summary.totalGrossSalary =
      roundCurrency(
        summary.totalGrossSalary
      );

    summary.totalNetSalary =
      roundCurrency(
        summary.totalNetSalary
      );

    return res.json({
      startDate,
      endDate,
      employees:
        previewEmployees,
      summary,
    });
  } catch (err) {
    console.error(
      'BULK PAYOUT PREVIEW ERROR:',
      err
    );

    return res.status(500).json({
      message:
        'Failed to generate bulk payout preview.',
    });
  }
});

// ===============================================
// RETIRED: LEGACY BULK PAYOUTS
// ===============================================
// The old per-employee bulk flow ignored BulkPayout records when checking
// overlap and advance recovery. It has no frontend caller; use POST /bulk.
router.post('/bulk-legacy', (req, res) =>
  res.status(410).json({
    message: 'This endpoint has been retired. Use POST /api/payout/bulk.',
  })
);

// ===============================================
// CREATE PAYOUT
// ===============================================
router.post('/bulk', async (req, res) => {
  const { startDate, endDate, payrollPeriod = {}, payouts } = req.body;
  const range = validatePayrollRange(startDate, endDate);

  if (!range.valid) {
    return res.status(range.status).json({ message: range.message });
  }
  if (!Array.isArray(payouts) || payouts.length === 0) {
    return res.status(400).json({ message: 'Please select at least one employee payout.' });
  }
  if (payouts.some((item) => !mongoose.Types.ObjectId.isValid(item.employeeId))) {
    return res.status(400).json({ message: 'Each selected employee must be valid.' });
  }

  const ids = payouts.map((item) => String(item.employeeId));
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ message: 'An employee can only appear once in a bulk payout.' });
  }

  const session = await mongoose.startSession();
  try {
    let savedPayout;
    await session.withTransaction(async () => {
      const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
      // Sequential: a transaction session must never run operations in parallel.
      const employees = await Employee.find({ _id: { $in: objectIds }, isActive: true }).session(session).lean();
      const attendance = await Attendance.find({ employee: { $in: objectIds }, date: { $lte: range.end } }).session(session).lean();
      const legacyPayouts = await Payout.find({ employee: { $in: objectIds } }).session(session).lean();
      const bulkPayouts = await BulkPayout.find({ 'employees.employee': { $in: objectIds } }).session(session).lean();
      if (employees.length !== objectIds.length) {
        throw new Error('Every selected employee must exist and be active.');
      }

      const employeeById = new Map(employees.map((employee) => [String(employee._id), employee]));
      const attendanceByEmployee = groupByEmployee(attendance);
      const payoutsByEmployee = buildPayoutHistoryByEmployee(legacyPayouts, bulkPayouts);
      const lines = payouts.map((request) => {
        const employeeId = String(request.employeeId);
        const employee = employeeById.get(employeeId);
        const employeeAttendance = attendanceByEmployee.get(employeeId) || [];
        const history = payoutsByEmployee.get(employeeId) || [];
        if (!employeeAttendance.some((record) => record.date >= range.start && record.date <= range.end)) {
          throw new Error(`${employee.name} has no attendance marked for this payroll period.`);
        }
        const overlap = findOverlappingPayout(history, range.start, range.end);
        if (overlap) {
          const error = new Error(`${employee.name} already has a payout for an overlapping period.`);
          error.code = 'PAYOUT_OVERLAP';
          error.employeeName = employee.name;
          error.overlap = getOverlapDetails(overlap);
          throw error;
        }
        const hourlyRate = roundCurrency(employee.baseDailySalary / STANDARD_WORK_HOURS);
        const payroll = calculatePayrollMetrics(employeeAttendance, range.start, range.end, hourlyRate);
        const advanceStatus = calculateAdvanceStatus(
          employeeAttendance,
          history.filter((payout) => new Date(payout.endDate) <= range.end)
        );
        const advanceDeducted = Number(request.advanceDeducted || 0);
        const deductions = Number(request.deductions || 0);
        if (!Number.isFinite(advanceDeducted) || advanceDeducted < 0 || advanceDeducted > advanceStatus.remainingAdvance) {
          throw new Error(`${employee.name} has an invalid advance recovery.`);
        }
        if (!Number.isFinite(deductions) || deductions < 0) {
          throw new Error(`${employee.name} has an invalid other deduction.`);
        }
        const netSalary = calculateNetSalary(payroll.grossSalary, advanceDeducted, deductions);
        if (netSalary < 0) throw new Error(`${employee.name} has deductions greater than gross salary.`);
        return {
          employee: employee._id, employeeName: employee.name, totalDaysWorked: payroll.totalDaysWorked,
          totalHoursWorked: payroll.totalHoursWorked, fullWorkingDays: payroll.workingTime.fullWorkingDays,
          remainingWorkingHours: payroll.workingTime.remainingWorkingHours, overtimeHours: payroll.overtimeHours,
          dailySalary: employee.baseDailySalary, hourlyRate, baseSalary: payroll.baseSalary,
          overtimeAmount: payroll.overtimeAmount, grossSalary: payroll.grossSalary,
          outstandingAdvanceBefore: advanceStatus.remainingAdvance, advanceDeducted,
          outstandingAdvanceAfter: roundCurrency(advanceStatus.remainingAdvance - advanceDeducted), deductions,
          netSalary, paymentMethod: VALID_PAYMENT_METHODS.includes(request.paymentMethod) ? request.paymentMethod : 'cash',
        };
      });
      const total = (key) => roundCurrency(lines.reduce((sum, line) => sum + Number(line[key] || 0), 0));
      [savedPayout] = await BulkPayout.create([{
        payoutNumber: await generateBulkPayoutNumber(session),
        payrollPeriod: { code: String(payrollPeriod.code || '').trim(), name: String(payrollPeriod.name || '').trim() },
        startDate: range.start, endDate: range.end, paidOn: new Date(), employeeCount: lines.length,
        totalGross: total('grossSalary'), totalAdvanceCut: total('advanceDeducted'),
        totalAdvanceLeft: total('outstandingAdvanceAfter'), totalOtherDeduction: total('deductions'),
        totalNetPaid: total('netSalary'), employees: lines, generatedBy: 'Admin',
      }], { session });
    });
    return res.status(201).json({ payout: savedPayout });
  } catch (err) {
    if (err.code === 'PAYOUT_OVERLAP') {
      return res.status(409).json({
        message: err.message,
        code: err.code,
        employeeName: err.employeeName,
        overlap: err.overlap,
      });
    }

    return res.status(400).json({ message: err.message || 'Unable to create bulk payout.' });
  } finally {
    await session.endSession();
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      employeeId,
      startDate,
      endDate,
      deductions,
      advanceDeducted,
      paymentMethod,
      remarks
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ message: 'Invalid Employee ID format.' });
    }

    if (!employeeId || !startDate || !endDate) {
      return res.status(400).json({ message: 'Employee and date range are required.' });
    }

    const range = validatePayrollRange(startDate, endDate);
    if (!range.valid) {
      return res.status(range.status).json({
        message: range.message,
      });
    }

    const employee = await Employee.findById(employeeId).lean();
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found.' });
    }
    if (!employee.isActive) {
      return res.status(400).json({ message: 'Cannot create payout for an inactive employee.' });
    }

    // Validate payment method against an allowed list.
    const validPaymentMethods = ['cash', 'upi', 'bank', 'cheque'];
    if (paymentMethod && !validPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({ message: 'Invalid payment method provided.' });
    }

    // Sanitize and validate remarks.
    const finalRemarks = (remarks || '').trim();
    if (finalRemarks.length > 500) {
      return res.status(400).json({ message: 'Remarks cannot exceed 500 characters.' });
    }

    const overlapResponse = (overlap) =>
      res.status(409).json({
        message: 'A payout for an overlapping period already exists.',
        code: 'PAYOUT_OVERLAP',
        employeeName: employee.name,
        overlap: getOverlapDetails(overlap),
      });

    // Validate BEFORE starting a transaction. These reads use no session, so
    // running them in parallel is safe. Overlap and advance recovery consider
    // BOTH single payouts and bulk payout lines.
    const [allAttendance, payoutHistory] = await Promise.all([
      Attendance.find({ employee: employeeId, date: { $lte: range.end } }).lean(),
      loadEmployeePayoutHistory(employeeId),
    ]);

    const overlap = findOverlappingPayout(payoutHistory, range.start, range.end);
    if (overlap) {
      return overlapResponse(overlap);
    }

    const previousPayouts = filterPayoutsEndingBy(payoutHistory, range.end);

    const hourlyRate = roundCurrency(employee.baseDailySalary / STANDARD_WORK_HOURS);
    const payroll = calculatePayrollMetrics(
      allAttendance,
      range.start,
      range.end,
      hourlyRate
    );
    const advanceStatus = calculateAdvanceStatus(
      allAttendance,
      previousPayouts
    );

    const manualAdvance = Number(advanceDeducted || 0);
    if (manualAdvance > advanceStatus.remainingAdvance) {
      return res.status(400).json({ message: `Maximum recoverable advance is ₹${roundCurrency(advanceStatus.remainingAdvance)}` });
    }
    if (!Number.isFinite(manualAdvance) || manualAdvance < 0) {
      return res.status(400).json({ message: 'Advance deduction cannot be negative.' });
    }

    const otherDeduction = Number(deductions || 0);
    if (!Number.isFinite(otherDeduction) || otherDeduction < 0) {
      return res.status(400).json({ message: 'Other deduction cannot be negative.' });
    }
    const netCheck = validateNetSalary(
      payroll.grossSalary,
      manualAdvance,
      otherDeduction,
      employee.name
    );
    if (!netCheck.valid) {
      return res.status(400).json({ message: netCheck.message });
    }
    const netSalary = netCheck.netSalary;

    // The transaction only covers the writes (counter + payout), with a
    // sequential overlap re-check against payouts created in the meantime.
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const latestHistory = await loadEmployeePayoutHistory(employeeId, session);
      const latestOverlap = findOverlappingPayout(latestHistory, range.start, range.end);
      if (latestOverlap) {
        const overlapError = new Error('A payout for an overlapping period already exists.');
        overlapError.code = 'PAYOUT_OVERLAP';
        overlapError.overlapRecord = latestOverlap;
        throw overlapError;
      }

      const salarySlipNumber = await generatePayoutNumber(session);

      const payout = new Payout({
      employee: employeeId,
      startDate,
      endDate,
      totalDaysWorked: payroll.totalDaysWorked,
      totalHoursWorked: payroll.totalHoursWorked,
      fullWorkingDays: payroll.workingTime.fullWorkingDays,
      remainingWorkingHours: payroll.workingTime.remainingWorkingHours,
      overtimeHours: payroll.overtimeHours,
      dailySalary: employee.baseDailySalary,
      hourlyRate,
      baseSalary: payroll.baseSalary,
      overtimeAmount: payroll.overtimeAmount,
      grossSalary: payroll.grossSalary,
      totalAmount: payroll.grossSalary, // For legacy compatibility
      outstandingAdvanceBefore: advanceStatus.remainingAdvance,
      advanceDeducted: manualAdvance,
      outstandingAdvanceAfter: Math.max(0, advanceStatus.remainingAdvance - manualAdvance),
      deductions: otherDeduction,
      netSalary,
      paymentMethod: paymentMethod || "",
      status: "Pending",
      paidOn: null,
      remarks: finalRemarks,
      // Hardcoded for now, but with a clear TODO. Never trust client-provided security-sensitive data.
      generatedBy: "Admin", // TODO: Replace with authenticated user (req.user.id)
      // Improved uniqueness for salary slip numbers to prevent collisions.
      salarySlipNumber,
    });

      // `save()` returns a single document, not an array.
      const saved = await payout.save({ session });

      await session.commitTransaction();

      await saved.populate('employee', 'name workType baseDailySalary');

      return res.status(201).json(saved);
    } catch (err) {
      // Abort only a transaction that is still active (idempotent).
      if (session.inTransaction()) {
        try {
          await session.abortTransaction();
        } catch (abortErr) {
          // Never let an abort failure replace the original response.
          console.error('PAYOUT ABORT ERROR:', abortErr);
        }
      }
      if (err.code === 'PAYOUT_OVERLAP') {
        return overlapResponse(err.overlapRecord);
      }
      return sendServerError(res, 'CREATE PAYOUT', err, 'Failed to create payout.');
    } finally {
      // End the session exactly once.
      await session.endSession();
    }
  } catch (err) {
    return sendServerError(res, 'CREATE PAYOUT', err);
      }
});

// ===============================================
// Salary Register
// ===============================================
router.post('/register', async (req, res) => {
  try {
    const { startDate, endDate } = req.body;

    const range = validatePayrollRange(startDate, endDate);
    if (!range.valid) {
      return res.status(range.status).json({
        message: range.message,
      });
    }

    // Using a MongoDB Aggregation Pipeline is the only scalable way to implement this.
    // It moves all computation to the database, preventing server memory overload.
    const salaryRegisterData = await Employee.aggregate([
      { $match: { isActive: true } },
      { $sort: { name: 1 } },
      {
        $lookup: {
          from: 'attendances',
          localField: '_id',
          foreignField: 'employee',
          as: 'attendanceRecords'
        }
      },
      {
        $lookup: {
          from: 'payouts',
          localField: '_id',
          foreignField: 'employee',
          as: 'payoutRecords'
        }
      },
      {
        $project: {
          employeeName: '$name',
          dailySalary: '$baseDailySalary',
          // Calculate payroll metrics directly in the database.
          payroll: {
            $let: {
              vars: {
                hourlyRate: { $divide: ['$baseDailySalary', STANDARD_WORK_HOURS] },
                periodAttendance: {
                  $filter: {
                    input: '$attendanceRecords',
                    as: 'att',
                    cond: { $and: [{ $gt: [{ $ifNull: ['$$att.workHours', 0] }, 0] }, { $gte: ['$$att.date', range.start] }, { $lte: ['$$att.date', range.end] }] }
                  }
                }
              },
              in: {
                workingDays: { $size: '$$periodAttendance' },
                workingHours: { $sum: '$$periodAttendance.workHours' },
                overtimeHours: { $sum: '$$periodAttendance.overtime' },
                baseSalary: { $multiply: [{ $sum: '$$periodAttendance.workHours' }, '$$hourlyRate'] },
                overtimeAmount: { $multiply: [{ $sum: '$$periodAttendance.overtime' }, '$$hourlyRate'] }
              }
            }
          },
          // Calculate lifetime advance status in the database.
          advance: {
            totalAdvanceTaken: { $sum: '$attendanceRecords.advancePayment' },
            advanceRecovered: { $sum: '$payoutRecords.advanceDeducted' } // Corrected field name
          }
        }
      }
    ]);

    // Process the aggregation results in memory, which is now a very small and fast operation.
    const register = salaryRegisterData.map(item => {
      const grossSalary = roundCurrency(item.payroll.baseSalary + item.payroll.overtimeAmount);
      const remainingAdvance = Math.max(0, roundCurrency(item.advance.totalAdvanceTaken - item.advance.advanceRecovered));
      const netSalary = calculateNetSalary(grossSalary, 0, 0);

      const workingTime = getWorkingTime(item.payroll.workingHours);

      return {
        employeeId: item._id, // The aggregation returns _id
        employeeName: item.employeeName,
        dailySalary: item.dailySalary,
        workingDays: workingTime.fullWorkingDays,
        workingHours: workingTime.totalHours,
        fullWorkingDays: workingTime.fullWorkingDays,
        remainingWorkingHours: workingTime.remainingWorkingHours,
        workingTime,
        overtimeHours: item.payroll.overtimeHours,
        overtimeAmount: roundCurrency(item.payroll.overtimeAmount),
        baseSalary: roundCurrency(item.payroll.baseSalary),
        grossSalary,
        remainingAdvance,
        advanceDeducted: 0,
        otherDeduction: 0,
        netSalary,
      };
    });

    const summary = register.reduce((acc, curr) => {
      acc.totalSalary += curr.grossSalary;
      acc.totalAdvance += curr.remainingAdvance;
      acc.totalNetSalary += curr.netSalary;
      return acc;
    }, { totalEmployees: register.length, totalSalary: 0, totalAdvance: 0, totalNetSalary: 0 });

    res.json({
      register,
      summary: {
        totalEmployees: summary.totalEmployees,
        totalSalary: roundCurrency(summary.totalSalary),
        totalAdvance: roundCurrency(summary.totalAdvance),
        totalNetSalary: roundCurrency(summary.totalNetSalary),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: 'Failed to generate salary register.',
    });
  }
});

// ======================================
// MARK SALARY AS PAID
// ======================================

router.patch("/:id/pay", async (req, res) => {
  try {

    const { paymentMethod } = req.body;

    const payout = await Payout.findById(req.params.id);

    if (!payout) {
      return res.status(404).json({
        message: "Payout not found",
      });
    }

    payout.status = "Paid";
    payout.paymentMethod = paymentMethod;
    payout.paidOn = new Date();

    await payout.save();

    res.json(payout);

  } catch (err) {

    sendServerError(res, 'MARK PAYOUT PAID', err);

  }
});

// ======================================
// UPDATE PAYOUT STATUS
// ======================================

router.patch("/:id/status", async (req, res) => {
  try {

    const { status } = req.body;

    const payout = await Payout.findById(req.params.id);

    if (!payout) {
      return res.status(404).json({
        message: "Payout not found",
      });
    }

    payout.status = status;

    if (status === "Paid") {
      payout.paidOn = new Date();
    } else {
      payout.paidOn = null;
      payout.paymentMethod = "";
    }

    await payout.save();

    res.json(payout);

  } catch (err) {

    sendServerError(res, 'UPDATE PAYOUT STATUS', err);

  }
});

// ===============================================
// EDIT PAYOUTS (payment method, advance cut, other deduction)
// ===============================================
// Rules live in utils/payoutEdit.js. All validation runs before a transaction;
// inside it, data is re-read sequentially and re-validated before one write.

const editFailure = (result) => {
  const error = new Error(result.message);
  error.editResult = result;
  return error;
};

const sendEditFailure = (res, result) => {
  const { ok, status, ...body } = result;
  return res.status(status).json(body);
};

const abortIfActive = async (session, label) => {
  if (!session.inTransaction()) return;
  try {
    await session.abortTransaction();
  } catch (abortErr) {
    console.error(`${label} ABORT ERROR:`, abortErr);
  }
};

const findPopulatedPayout = (id) =>
  Payout.findById(id).populate('employee', 'name workType baseDailySalary');

/** Attendance + payout history for bulk lines whose amounts change. */
const loadBulkEditContext = async (bulk, edits, session = null) => {
  const ids = payoutEdit.getBulkChangedEmployeeIds(bulk, edits);
  const contexts = new Map();
  if (ids.length === 0) return contexts;

  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const withSession = (query) => (session ? query.session(session) : query);
  const attendanceQuery = () => withSession(Attendance.find({ employee: { $in: objectIds } }).lean());
  const payoutQuery = () => withSession(Payout.find({ employee: { $in: objectIds } }).lean());
  const bulkQuery = () => withSession(BulkPayout.find({ 'employees.employee': { $in: objectIds } }).lean());
  // A session must never run two operations at once.
  const [attendance, legacyPayouts, bulkPayouts] = session
    ? [await attendanceQuery(), await payoutQuery(), await bulkQuery()]
    : await Promise.all([attendanceQuery(), payoutQuery(), bulkQuery()]);

  const attendanceByEmployee = groupByEmployee(attendance);
  const historyByEmployee = buildPayoutHistoryByEmployee(legacyPayouts, bulkPayouts);
  ids.forEach((id) => {
    contexts.set(id, {
      attendance: attendanceByEmployee.get(id) || [],
      history: historyByEmployee.get(id) || [],
    });
  });
  return contexts;
};

router.patch('/bulk/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: 'Invalid bulk payout ID.' });
  }
  const parsed = payoutEdit.parseBulkEditBody(req.body);
  if (!parsed.ok) return sendEditFailure(res, parsed);
  const { edits } = parsed;

  // Validate before any transaction (no session: parallel reads are fine).
  try {
    const bulk = await BulkPayout.findById(id).lean();
    if (!bulk) return res.status(404).json({ message: 'Bulk payout not found.' });
    const contexts = await loadBulkEditContext(bulk, edits);
    const plan = payoutEdit.planBulkEdit(bulk, edits, contexts);
    if (!plan.ok) return sendEditFailure(res, plan);
    if (plan.noop) return res.json({ payout: bulk });
  } catch (err) {
    console.error('BULK PAYOUT EDIT ERROR:', err);
    return res.status(500).json({ message: 'Unable to edit bulk payout.' });
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const fresh = await BulkPayout.findById(id).session(session).lean();
    if (!fresh) throw editFailure({ ok: false, status: 404, message: 'Bulk payout not found.' });
    const contexts = await loadBulkEditContext(fresh, edits, session);
    const plan = payoutEdit.planBulkEdit(fresh, edits, contexts);
    if (!plan.ok) throw editFailure(plan);
    if (!plan.noop) {
      await BulkPayout.updateOne({ _id: fresh._id }, { $set: plan.set }, { session, runValidators: true });
    }
    await session.commitTransaction();
  } catch (err) {
    await abortIfActive(session, 'BULK PAYOUT EDIT');
    if (err.editResult) return sendEditFailure(res, err.editResult);
    console.error('BULK PAYOUT EDIT ERROR:', err);
    return res.status(500).json({ message: 'Unable to edit bulk payout.' });
  } finally {
    await session.endSession();
  }

  try {
    const updated = await BulkPayout.findById(id).lean();
    return res.json({ payout: updated });
  } catch (err) {
    console.error('BULK PAYOUT EDIT READ ERROR:', err);
    return res.status(500).json({ message: 'Bulk payout was updated but could not be reloaded.' });
  }
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: 'Invalid payout ID.' });
  }
  const parsed = payoutEdit.parseSingleEditBody(req.body);
  if (!parsed.ok) return sendEditFailure(res, parsed);
  const { edits } = parsed;

  let employeeId;
  let employeeName;
  // Validate before any transaction (no session: parallel reads are fine).
  try {
    const payout = await Payout.findById(id).lean();
    if (!payout) return res.status(404).json({ message: 'Payout not found.' });
    employeeId = String(payout.employee);
    const [employee, attendance, history] = await Promise.all([
      Employee.findById(employeeId).select('name').lean(),
      Attendance.find({ employee: employeeId }).lean(),
      loadEmployeePayoutHistory(employeeId),
    ]);
    employeeName = employee?.name;
    const plan = payoutEdit.planSingleEdit(payout, edits, { attendance, history, employeeName });
    if (!plan.ok) return sendEditFailure(res, plan);
    if (plan.noop) return res.json(await findPopulatedPayout(id));
  } catch (err) {
    console.error('PAYOUT EDIT ERROR:', err);
    return res.status(500).json({ message: 'Unable to edit payout.' });
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const fresh = await Payout.findById(id).session(session).lean();
    if (!fresh) throw editFailure({ ok: false, status: 404, message: 'Payout not found.' });
    const history = await loadEmployeePayoutHistory(employeeId, session);
    const attendance = await Attendance.find({ employee: employeeId }).session(session).lean();
    const plan = payoutEdit.planSingleEdit(fresh, edits, { attendance, history, employeeName });
    if (!plan.ok) throw editFailure(plan);
    if (!plan.noop) {
      await Payout.updateOne({ _id: fresh._id }, { $set: plan.set }, { session, runValidators: true });
    }
    await session.commitTransaction();
  } catch (err) {
    await abortIfActive(session, 'PAYOUT EDIT');
    if (err.editResult) return sendEditFailure(res, err.editResult);
    console.error('PAYOUT EDIT ERROR:', err);
    return res.status(500).json({ message: 'Unable to edit payout.' });
  } finally {
    await session.endSession();
  }

  try {
    return res.json(await findPopulatedPayout(id));
  } catch (err) {
    console.error('PAYOUT EDIT READ ERROR:', err);
    return res.status(500).json({ message: 'Payout was updated but could not be reloaded.' });
  }
});

// ===============================================
// DELETE BULK PAYOUT
// ===============================================

router.delete('/bulk/:id', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'Invalid bulk payout ID.' });
  }

  const session = await mongoose.startSession();
  try {
    let deletedPayout;
    await session.withTransaction(async () => {
      const payout = await BulkPayout.findById(req.params.id).session(session);
      if (!payout) {
        const error = new Error('Bulk payout not found.');
        error.status = 404;
        throw error;
      }
      deletedPayout = await BulkPayout.findByIdAndDelete(payout._id, { session });
    });

    return res.json({
      message: 'Bulk payout permanently deleted. The affected period is eligible for payout again.',
      employeeCount: deletedPayout.employeeCount,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return sendServerError(res, 'DELETE BULK PAYOUT', err, 'Unable to delete bulk payout.');
  } finally {
    await session.endSession();
  }
});

// ===============================================
// DELETE SINGLE PAYOUT
// ===============================================

router.delete("/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'Invalid payout ID.' });
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const payout = await Payout.findById(req.params.id).session(session);
      if (!payout) {
        const error = new Error('Payout not found.');
        error.status = 404;
        throw error;
      }
      await Payout.deleteOne({ _id: payout._id }).session(session);
    });

    return res.json({ message: 'Payout permanently deleted. The affected period is eligible for payout again.' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return sendServerError(res, 'DELETE PAYOUT', err, 'Unable to delete payout.');
  } finally {
    await session.endSession();
  }
});

module.exports = router;
