const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');

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

    const hours = Number(workHours ?? 0);
    const ot = Number(overtime ?? 0);
    const advance = Number(advancePayment ?? 0);

    if (hours < 0 || hours > 24) {
      return res.status(400).json({
        message: 'Work hours must be between 0 and 24.'
      });
    }

    if (ot < 0 || ot > 24) {
      return res.status(400).json({
        message: 'Overtime must be between 0 and 24.'
      });
    }

    if (advance < 0) {
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
      present: present,
      // Only fall back to 8 when the value is truly missing/blank.
      // (Using "workHours || 8" would wrongly turn a real 0 — an absent
      //  employee — back into 8, because 0 is "falsy" in JavaScript.)
      workHours: (workHours === '' || workHours === undefined || workHours === null) ? 8 : workHours,
      overtime: (overtime === '' || overtime === undefined || overtime === null) ? 0 : overtime,
      advancePayment: (advancePayment === '' || advancePayment === undefined || advancePayment === null) ? 0 : advancePayment,
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

    const updateFields = ['present', 'workHours', 'overtime', 'advancePayment', 'notes'];
    updateFields.forEach(field => {
      if (req.body[field] !== undefined) {
        attendance[field] = req.body[field];
      }
    });

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
      const { employeeId, present, workHours, overtime, advancePayment, notes } = record;
      
      // Check if attendance already exists
      const exists = await Attendance.findOne({
        employee: employeeId,
        date: new Date(date)
      });

      if (!exists) {
        bulkAttendance.push({
          employee: employeeId,
          date: date,
          present: present,
          workHours: workHours || 8,
          overtime: overtime || 0,
          advancePayment: advancePayment || 0,
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
