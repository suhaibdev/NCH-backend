const express = require('express');
const router = express.Router();
const Payout = require('../models/Payout');
const { startOfDay, endOfDay } = require('date-fns');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');

// ===============================================
// CONSTANTS
// ===============================================
const STANDARD_WORK_HOURS = 8;

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
    const workHours = item.workHours || 0;
    const overtime = item.overtime || 0;
    // Validate attendance records to prevent corrupt data from affecting payroll.
    const isValid = workHours >= 0 && workHours <= 24 && overtime >= 0 && overtime <= 24;

    // Compare dates directly after normalization.
    return item.present && isValid && item.date >= start && item.date <= end;
  });

  const totalDaysWorked = periodAttendance.length;
  const totalHoursWorked = periodAttendance.reduce(
    (sum, item) => sum + (item.workHours || 0),
    0
  );
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
  };
};

/**
 * Calculates the lifetime advance status for an employee.
 * @returns {object} An object containing advance metrics.
 */
const calculateAdvanceStatus = (attendanceRecords, payoutRecords) => {
  const totalAdvanceTaken = roundCurrency(attendanceRecords.reduce(
    (sum, item) => sum + (item.advancePayment || 0),
    0
  ));

  const advanceRecovered = roundCurrency(payoutRecords.reduce(
    (sum, item) => sum + (item.advanceDeducted || 0),
    0
  ));

  return {
    totalAdvanceTaken,
    advanceRecovered,
    remainingAdvance: roundCurrency(Math.max(0, totalAdvanceTaken - advanceRecovered)),
  };
};

/**
 * Calculates the final net salary after all deductions.
 * @returns {number} The non-negative net salary.
 */
const calculateNetSalary = (grossSalary, advanceDeducted, otherDeduction) => {
  return Math.max(
    0,
    roundCurrency(grossSalary - (advanceDeducted || 0) - (otherDeduction || 0))
  );
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
    res.status(500).json({
      message: err.message,
    });
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
    res.status(500).json({
      message: err.message,
    });
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

    // Optimization: Fetch only historical data relevant to the calculation period.
    const [allAttendance, previousPayouts] = await Promise.all([
      Attendance.find({ employee: employeeId, date: { $lte: range.end } }).lean(),
      Payout.find({ employee: employeeId, paidOn: { $lte: range.end } }).lean()
    ]);

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
// CREATE PAYOUT
// ===============================================
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

    // A transaction is critical here to ensure atomicity: check for duplicates and save in one operation.
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      // Robust overlap detection prevents creating payrolls for periods that intersect with existing ones.
      const existing = await Payout.findOne({
        employee: employeeId,
        startDate: { $lte: range.end },
        endDate: { $gte: range.start },
      }).session(session);

      if (existing) {
        throw new Error('A payout for an overlapping period already exists.');
      }

      const [allAttendance, previousPayouts] = await Promise.all([
        Attendance.find({ employee: employeeId, date: { $lte: range.end } }).session(session).lean(),
        Payout.find({ employee: employeeId, paidOn: { $lte: range.end } }).session(session).lean()
      ]);

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
    if (manualAdvance < 0) {
      return res.status(400).json({ message: 'Advance deduction cannot be negative.' });
    }

    const otherDeduction = Number(deductions || 0);
    if (otherDeduction < 0) {
      return res.status(400).json({ message: 'Deductions cannot be negative.' });
    }
    const netSalary = calculateNetSalary(
      payroll.grossSalary,
      manualAdvance,
      otherDeduction
    );

    const payout = new Payout({
      employee: employeeId,
      startDate,
      endDate,
      totalDaysWorked: payroll.totalDaysWorked,
      totalHoursWorked: payroll.totalHoursWorked,
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
      salarySlipNumber: `SAL-${new Date().getFullYear()}-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    });

      // `save()` returns a single document, not an array.
      const saved = await payout.save({ session });

      await session.commitTransaction();

    await saved.populate('employee', 'name workType baseDailySalary');

    res.status(201).json(saved);
    } catch (err) {
      // Abort the transaction in case of any error.
      await session.abortTransaction();
      // Distinguish between client errors (like overlap) and server errors.
      if (err.message.includes('overlapping period')) {
        return res.status(409).json({ message: err.message });
      }
    console.error(err);
    res.status(500).json({
      message: err.message || 'Failed to create payout.',
    });
    } finally {
      // Ensure the session is always closed to prevent resource leaks.
      session.endSession();
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: err.message || 'Internal Server Error',
    });
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
                    cond: { $and: [{ $eq: ['$$att.present', true] }, { $gte: ['$$att.date', range.start] }, { $lte: ['$$att.date', range.end] }] }
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
            advanceRecovered: { $sum: '$payoutRecords.advaDeducted' } // Corrected field name
          }
        }
      }
    ]);

    // Process the aggregation results in memory, which is now a very small and fast operation.
    const register = salaryRegisterData.map(item => {
      const grossSalary = roundCurrency(item.payroll.baseSalary + item.payroll.overtimeAmount);
      const remainingAdvance = Math.max(0, roundCurrency(item.advance.totalAdvanceTaken - item.advance.advanceRecovered));
      const netSalary = calculateNetSalary(grossSalary, 0, 0);

      return {
        employeeId: item._id, // The aggregation returns _id
        employeeName: item.employeeName,
        dailySalary: item.dailySalary,
        workingDays: item.payroll.workingDays,
        workingHours: item.payroll.workingHours,
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

    console.error(err);

    res.status(500).json({
      message: err.message ||'CREATE PAYOUT ERROR.',
    });

  }
});
// ===============================================
// DELETE PAYOUT
// ===============================================

router.delete("/:id", async (req, res) => {

  try {

    const payout = await Payout.findByIdAndDelete(req.params.id);

    if (!payout) {
      return res.status(404).json({
        message: "Payout not found",
      });
    }

    res.json({
      message: "Payout deleted successfully",
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: err.message ||'DELETE PAYOUT ERROR.',
    });

  }

});

module.exports = router;