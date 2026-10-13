const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const {
  isPresentByWorkHours,
  toFiniteNumber,
} = require('../utils/payroll');

const hasValidHours = (value) =>
  Number.isFinite(value) && value >= 0 && value <= 24;

const hasValidAdvance = (value) =>
  Number.isFinite(value) && value >= 0;

// Get all attendance records
router.get('/', async (req, res) => {
  try {
    const attendance = await Attendance.find()
      .populate('employee', 'name')
      .sort({ date: -1 });
    res.json(attendance);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get attendance by date range
router.get('/range', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const attendance = await Attendance.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      }
    }).populate('employee', 'name');
    res.json(attendance);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get attendance by employee
router.get('/employee/:employeeId', async (req, res) => {
  try {
    const attendance = await Attendance.find({
      employee: req.params.employeeId
    })
    .populate('employee', 'name')
    .sort({ date: -1 });
    res.json(attendance);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Mark attendance for an employee
router.post('/', async (req, res) => {
  try {
    const { employeeId, date, present, workHours, overtime, advancePayment, notes } = req.body;
    // Validation

    if (!employeeId || !date) {
      return res.status(400).json({
        message: 'Employee and date are required.'
      });
    }

    const hours = workHours === '' || workHours === undefined || workHours === null
      ? 8
      : Number(workHours);
    const ot = Number(overtime ?? 0);
    const advance = Number(advancePayment ?? 0);

    if (!hasValidHours(hours)) {
      return res.status(400).json({
        message: 'Work hours must be between 0 and 24.'
      });
    }

    if (!hasValidHours(ot)) {
      return res.status(400).json({
        message: 'Overtime must be between 0 and 24.'
      });
    }

    if (!hasValidAdvance(advance)) {
      return res.status(400).json({
        message: 'Advance payment cannot be negative.'
      });
    }

    // Check if employee exists
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Check if attendance already marked for this date
    const selectedDate = new Date(date);

    const startOfDay = new Date(selectedDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(selectedDate);
    endOfDay.setHours(23, 59, 59, 999);

    const existingAttendance = await Attendance.findOne({
      employee: employeeId,
      date: {
        $gte: startOfDay,
        $lte: endOfDay
      }
    });

    if (existingAttendance) {
      return res.status(400).json({ 
        message: 'Attendance already marked for this date' 
      });
    }

    const attendance = new Attendance({
      employee: employeeId,
      date: date,
      // A zero-hour record is always absent, regardless of a client flag.
      present: isPresentByWorkHours(hours),
      // Only fall back to 8 when the value is truly missing/blank.
      // (Using "workHours || 8" would wrongly turn a real 0 — an absent
      //  employee — back into 8, because 0 is "falsy" in JavaScript.)
      workHours: hours,
      overtime: ot,
      advancePayment: advance,
      notes: notes
    });

    const newAttendance = await attendance.save();
    await newAttendance.populate('employee', 'name');
    res.status(201).json(newAttendance);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update attendance
router.put('/:id', async (req, res) => {
  try {
    const attendance = await Attendance.findById(req.params.id);
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    const workHours = req.body.workHours === undefined
      ? Number(attendance.workHours || 0)
      : toFiniteNumber(req.body.workHours, Number.NaN);
    const overtime = req.body.overtime === undefined
      ? Number(attendance.overtime || 0)
      : toFiniteNumber(req.body.overtime, Number.NaN);
    const advancePayment = req.body.advancePayment === undefined
      ? Number(attendance.advancePayment || 0)
      : toFiniteNumber(req.body.advancePayment, Number.NaN);

    if (!hasValidHours(workHours)) {
      return res.status(400).json({ message: 'Work hours must be between 0 and 24.' });
    }
    if (!hasValidHours(overtime)) {
      return res.status(400).json({ message: 'Overtime must be between 0 and 24.' });
    }
    if (!hasValidAdvance(advancePayment)) {
      return res.status(400).json({ message: 'Advance payment cannot be negative.' });
    }

    attendance.workHours = workHours;
    attendance.overtime = overtime;
    attendance.advancePayment = advancePayment;
    attendance.present = isPresentByWorkHours(workHours);

    if (req.body.notes !== undefined) {
      attendance.notes = req.body.notes;
    }

    const updatedAttendance = await attendance.save();
    await updatedAttendance.populate('employee', 'name');
    res.json(updatedAttendance);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete attendance
router.delete('/:id', async (req, res) => {
  try {
    const attendance = await Attendance.findById(req.params.id);
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }
    await attendance.deleteOne();
    res.json({ message: 'Attendance record deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Bulk mark attendance
router.post('/bulk', async (req, res) => {
  try {
    const { date, records } = req.body;
    const bulkAttendance = [];

    for (const record of records) {
      const { employeeId, workHours, overtime, advancePayment, notes } = record;
      const hours = workHours === '' || workHours === undefined || workHours === null
        ? 8
        : toFiniteNumber(workHours, Number.NaN);
      const ot = overtime === '' || overtime === undefined || overtime === null
        ? 0
        : toFiniteNumber(overtime, Number.NaN);
      const advance = advancePayment === '' || advancePayment === undefined || advancePayment === null
        ? 0
        : toFiniteNumber(advancePayment, Number.NaN);

      if (!employeeId || !hasValidHours(hours) || !hasValidHours(ot) || !hasValidAdvance(advance)) {
        return res.status(400).json({ message: 'Each bulk attendance record needs valid employee, work hours, overtime, and advance values.' });
      }
      
      // Check if attendance already exists
      const exists = await Attendance.findOne({
        employee: employeeId,
        date: new Date(date)
      });

      if (!exists) {
        bulkAttendance.push({
          employee: employeeId,
          date: date,
          present: isPresentByWorkHours(hours),
          workHours: hours,
          overtime: ot,
          advancePayment: advance,
          notes: notes
        });
      }
    }

    const result = await Attendance.insertMany(bulkAttendance);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});
// =======================================
// Outstanding Advance Report
// =======================================

router.get('/advance-summary', async (req, res) => {
  try {
    const summary = await Attendance.aggregate([
      {
        $match: {
          advancePayment: { $gt: 0 }
        }
      },
      {
        $group: {
          _id: '$employee',
          totalAdvance: {
            $sum: '$advancePayment'
          }
        }
      },
      {
        $lookup: {
          from: 'employees',
          localField: '_id',
          foreignField: '_id',
          as: 'employee'
        }
      },
      {
        $unwind: '$employee'
      },
      {
        $project: {
          employeeId: '$employee._id',
          employeeName: '$employee.name',
          totalAdvance: 1
        }
      },
      {
        $sort: {
          employeeName: 1
        }
      }
    ]);

    res.json(summary);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: 'Unable to load advance summary.'
    });
  }
});

module.exports = router;
