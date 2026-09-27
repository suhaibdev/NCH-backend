const express = require('express');
const router = express.Router();
const Payout = require('../models/Payout');
const { startOfDay, endOfDay } = require('date-fns');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');
const PayoutCounter = require('../models/PayoutCounter');
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
// BULK PAYOUT HELPERS
// ===============================================

const VALID_PAYMENT_METHODS = [
  'cash',
  'upi',
  'bank',
  'cheque',
];

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
 * Finds an existing payout that overlaps the requested payroll period.
 */
const findOverlappingPayout = (
  payoutRecords,
  start,
  end
) => {
  return payoutRecords.find((payout) => {
    if (!payout.startDate || !payout.endDate) {
      return false;
    }

    const payoutStart = new Date(
      payout.startDate
    );

    const payoutEnd = new Date(
      payout.endDate
    );

    return (
      payoutStart <= end &&
      payoutEnd >= start
    );
  });
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
      existingPayouts,
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
    ]);

    const attendanceByEmployee =
      groupByEmployee(
        historicalAttendance
      );

    const payoutsByEmployee =
      groupByEmployee(
        existingPayouts
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
            overlappingPayout
              ? {
                  payoutId:
                    overlappingPayout._id,

                  startDate:
                    overlappingPayout.startDate,

                  endDate:
                    overlappingPayout.endDate,

                  status:
                    overlappingPayout.status,

                  netSalary:
                    overlappingPayout.netSalary,
                }
              : null,
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
// CREATE BULK PAYOUTS
// ===============================================

router.post('/bulk', async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      payouts,
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

    if (
      !Array.isArray(payouts) ||
      payouts.length === 0
    ) {
      return res.status(400).json({
        message:
          'Please select at least one employee payout.',
      });
    }

    /*
     * Prevent duplicate employee IDs inside the
     * same request.
     */
    const uniqueItems = [];

    const seenEmployees =
      new Set();

    payouts.forEach((item) => {
      const id =
        item.employeeId?.toString();

      if (
        id &&
        !seenEmployees.has(id)
      ) {
        seenEmployees.add(id);

        uniqueItems.push(item);
      }
    });

    const created = [];
    const failed = [];

    /*
     * IMPORTANT:
     *
     * Each employee is processed separately.
     *
     * We intentionally DO NOT use one transaction
     * for the entire batch because you requested:
     *
     * successful payouts must stay created even
     * when another employee fails.
     */
    for (
      const item of uniqueItems
    ) {
      let session = null;

      try {
        const {
          employeeId,
          advanceDeducted = 0,
          deductions = 0,
          paymentMethod = 'cash',
          remarks = '',
        } = item;

        if (
          !mongoose.Types.ObjectId.isValid(
            employeeId
          )
        ) {
          throw new Error(
            'Invalid employee ID.'
          );
        }

        if (
          !VALID_PAYMENT_METHODS.includes(
            paymentMethod
          )
        ) {
          throw new Error(
            'Invalid payment method.'
          );
        }

        const employee =
          await Employee.findById(
            employeeId
          ).lean();

        if (!employee) {
          throw new Error(
            'Employee not found.'
          );
        }

        if (!employee.isActive) {
          throw new Error(
            'Employee is inactive.'
          );
        }

        /*
         * Bulk payout is allowed only when at
         * least one attendance record has been
         * marked during the selected period.
         */
        const attendanceMarked =
          await Attendance.exists({
            employee:
              employeeId,

            date: {
              $gte: range.start,
              $lte: range.end,
            },
          });

        if (!attendanceMarked) {
          throw new Error(
            'No attendance marked for this payroll period.'
          );
        }

        session =
          await mongoose.startSession();

        session.startTransaction();

        /*
         * Exact and partial overlap protection.
         */
        const existing =
          await Payout.findOne({
            employee:
              employeeId,

            startDate: {
              $lte: range.end,
            },

            endDate: {
              $gte: range.start,
            },
          }).session(session);

        if (existing) {
          throw new Error(
            'A payout for an overlapping period already exists.'
          );
        }

        const [
          allAttendance,
          previousPayouts,
        ] = await Promise.all([
          Attendance.find({
            employee:
              employeeId,

            date: {
              $lte: range.end,
            },
          })
            .session(session)
            .lean(),

          Payout.find({
            employee:
              employeeId,

            endDate: {
              $lte: range.end,
            },
          })
            .session(session)
            .lean(),
        ]);

        const hourlyRate =
          roundCurrency(
            employee.baseDailySalary /
              STANDARD_WORK_HOURS
          );

        const payroll =
          calculatePayrollMetrics(
            allAttendance,
            range.start,
            range.end,
            hourlyRate
          );

        const advanceStatus =
          calculateAdvanceStatus(
            allAttendance,
            previousPayouts
          );

        const manualAdvance =
          Number(
            advanceDeducted || 0
          );

        const otherDeduction =
          Number(
            deductions || 0
          );

        if (
          Number.isNaN(
            manualAdvance
          ) ||
          manualAdvance < 0
        ) {
          throw new Error(
            'Advance deduction cannot be negative.'
          );
        }

        if (
          manualAdvance >
          advanceStatus.remainingAdvance
        ) {
          throw new Error(
            `Maximum recoverable advance is ₹${roundCurrency(
              advanceStatus.remainingAdvance
            )}`
          );
        }

        if (
          Number.isNaN(
            otherDeduction
          ) ||
          otherDeduction < 0
        ) {
          throw new Error(
            'Other deduction cannot be negative.'
          );
        }

        /*
         * Do not silently create a negative salary.
         */
        if (
          manualAdvance +
            otherDeduction >
          payroll.grossSalary
        ) {
          throw new Error(
            'Total deductions cannot be greater than gross salary.'
          );
        }

        const finalRemarks =
          String(
            remarks || ''
          ).trim();

        if (
          finalRemarks.length >
          500
        ) {
          throw new Error(
            'Remarks cannot exceed 500 characters.'
          );
        }

        const netSalary =
          calculateNetSalary(
            payroll.grossSalary,
            manualAdvance,
            otherDeduction
          );

        const outstandingAfter =
          roundCurrency(
            Math.max(
              0,
              advanceStatus.remainingAdvance -
                manualAdvance
            )
          );

        const payout =
          new Payout({
            employee:
              employeeId,

            startDate:
              range.start,

            endDate:
              range.end,

            totalDaysWorked:
              payroll.totalDaysWorked,

            totalHoursWorked:
              payroll.totalHoursWorked,

            overtimeHours:
              payroll.overtimeHours,

            dailySalary:
              employee.baseDailySalary,

            hourlyRate,

            baseSalary:
              payroll.baseSalary,

            overtimeAmount:
              payroll.overtimeAmount,

            grossSalary:
              payroll.grossSalary,

            totalAmount:
              payroll.grossSalary,

            outstandingAdvanceBefore:
              advanceStatus.remainingAdvance,

            advanceDeducted:
              manualAdvance,

            outstandingAdvanceAfter:
              outstandingAfter,

            deductions:
              otherDeduction,

            netSalary,

            paymentMethod,

            status:
              'Pending',

            paidOn:
              null,

            remarks:
              finalRemarks,

            generatedBy:
              'Admin',

            printed:
              false,

            salarySlipNumber:
              await generatePayoutNumber(session),
          });

        const saved =
          await payout.save({
            session,
          });

        await session.commitTransaction();

        await saved.populate(
          'employee',
          'name baseDailySalary'
        );

        /*
         * These returned fields are also exactly
         * what the frontend print sheet will need.
         */
        created.push({
          _id:
            saved._id,

          employeeId:
            saved.employee?._id,

          employeeName:
            saved.employee?.name,

          startDate:
            saved.startDate,

          endDate:
            saved.endDate,

          totalDaysWorked:
            saved.totalDaysWorked,

          totalHoursWorked:
            saved.totalHoursWorked,

          grossSalary:
            saved.grossSalary,

          outstandingAdvanceBefore:
            saved.outstandingAdvanceBefore,

          advanceDeducted:
            saved.advanceDeducted,

          outstandingAdvanceAfter:
            saved.outstandingAdvanceAfter,

          deductions:
            saved.deductions,

          netSalary:
            saved.netSalary,

          paymentMethod:
            saved.paymentMethod,

          status:
            saved.status,

          createdAt:
            saved.createdAt,

          salarySlipNumber:
            saved.salarySlipNumber,
        });
      } catch (err) {
        if (
          session?.inTransaction()
        ) {
          await session.abortTransaction();
        }

        console.error(
          'BULK EMPLOYEE PAYOUT ERROR:',
          err
        );

        failed.push({
          employeeId:
            item.employeeId,

          employeeName:
            item.employeeName ||
            '',

          message:
            err.message ||
            'Failed to create payout.',
        });
      } finally {
        if (session) {
          session.endSession();
        }
      }
    }

    /*
     * Totals are based ONLY on payouts that
     * actually succeeded.
     */
    const summary =
      created.reduce(
        (result, payout) => {
          result.createdCount +=
            1;

          result.totalGrossSalary +=
            Number(
              payout.grossSalary ||
                0
            );

          result.totalAdvanceDeducted +=
            Number(
              payout.advanceDeducted ||
                0
            );

          result.totalOtherDeduction +=
            Number(
              payout.deductions ||
                0
            );

          result.totalNetSalary +=
            Number(
              payout.netSalary ||
                0
            );

          return result;
        },
        {
          createdCount: 0,

          failedCount:
            failed.length,

          totalGrossSalary: 0,

          totalAdvanceDeducted: 0,

          totalOtherDeduction: 0,

          totalNetSalary: 0,
        }
      );

    summary.totalGrossSalary =
      roundCurrency(
        summary.totalGrossSalary
      );

    summary.totalAdvanceDeducted =
      roundCurrency(
        summary.totalAdvanceDeducted
      );

    summary.totalOtherDeduction =
      roundCurrency(
        summary.totalOtherDeduction
      );

    summary.totalNetSalary =
      roundCurrency(
        summary.totalNetSalary
      );

    const responseBody = {
      message:
        failed.length === 0
          ? 'All selected payouts were created successfully.'
          : `${created.length} payout(s) created and ${failed.length} payout(s) failed.`,

      created,

      failed,

      summary,
    };

    /*
     * 201 = everything succeeded.
     * 207 = partial success.
     *
     * Axios treats both as successful HTTP
     * responses because both are 2xx statuses.
     */
    return res
      .status(
        failed.length > 0
          ? 207
          : 201
      )
      .json(responseBody);
  } catch (err) {
    console.error(
      'BULK PAYOUT ERROR:',
      err
    );

    return res.status(500).json({
      message:
        err.message ||
        'Failed to create bulk payouts.',
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
      salarySlipNumber: await generatePayoutNumber(session),
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

    console.error(err);

    res.status(500).json({
      message: err.message,
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