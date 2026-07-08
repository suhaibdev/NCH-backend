const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');

// Get all attendance records
router.get('/', async (req, res) => {
  try {
    const attendance = await Attendance.find()
      .populate('employee', 'name workType')
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
    }).populate('employee', 'name workType');
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
    .populate('employee', 'name workType')
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

    // Check if employee exists
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Check if attendance already marked for this date
    const existingAttendance = await Attendance.findOne({
      employee: employeeId,
      date: new Date(date)
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
    await newAttendance.populate('employee', 'name workType');
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
    await updatedAttendance.populate('employee', 'name workType');
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
    await attendance.remove();
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

module.exports = router;