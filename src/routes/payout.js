const express = require('express');
const router = express.Router();
const Payout = require('../models/Payout');
const Employee = require('../models/Employee');
const Attendance = require('../models/Attendance');

// Get all payouts
router.get('/', async (req, res) => {
  try {
    const payouts = await Payout.find()
      .populate('employee', 'name workType')
      .sort({ paidOn: -1 });
    res.json(payouts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get payout by employee
router.get('/:employeeId', async (req, res) => {
  try {
    const payouts = await Payout.find({
      employee: req.params.employeeId
    })
    .populate('employee', 'name workType baseDailySalary')
    .sort({ paidOn: -1 });
    res.json(payouts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Create new payout
router.post('/', async (req, res) => {
  try {
    const {
      employeeId,
      startDate,
      endDate,
      deductions,
      paymentMethod
    } = req.body;

    // Find employee
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Validate payout dates
    if (new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ message: 'Start date cannot be after end date' });
    }

    // Recompute everything from attendance on the SERVER.
    // We never trust money amounts sent from the browser — they could be
    // tampered with. The server is the single source of truth.
    const attendance = await Attendance.find({
      employee: employeeId,
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      },
      present: true
    });

    const HOURS_PER_DAY = 8; // One full working day = 8 hours.
    const hourlyRate = employee.baseDailySalary / HOURS_PER_DAY;

    const totalDaysWorked = attendance.length;
    const totalHoursWorked = attendance.reduce((total, record) =>
      total + (record.workHours || 0), 0);
    const overtimeHours = attendance.reduce((total, record) =>
      total + (record.overtime || 0), 0);

    // Pay is based on the actual hours worked.
    const totalAmount = totalHoursWorked * hourlyRate;
    const overtimeAmount = overtimeHours * hourlyRate;

    const existingPayout = await Payout.findOne({
      employee: employeeId,
      startDate: new Date(startDate),
      endDate: new Date(endDate)
    });

    if (existingPayout) {
      return res.status(409).json({ message: 'A payout already exists for this employee and date range.' });
    }

    const payout = new Payout({
      employee: employeeId,
      startDate,
      endDate,
      totalDaysWorked,
      totalHoursWorked,
      totalAmount,
      overtimeHours,
      overtimeAmount,
      deductions: deductions || 0,
      paymentMethod: paymentMethod || 'cash'
    });

    const newPayout = await payout.save();
    await newPayout.populate('employee', 'name workType baseDailySalary');
    res.status(201).json(newPayout);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update payout status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const payout = await Payout.findById(req.params.id);
    
    if (!payout) {
      return res.status(404).json({ message: 'Payout not found' });
    }

    if (!['pending', 'paid', 'cancelled'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    payout.status = status;
    if (status === 'paid') {
      payout.paidOn = new Date();
    }

    const updatedPayout = await payout.save();
    await updatedPayout.populate('employee', 'name workType');
    res.json(updatedPayout);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete payout
router.delete('/:id', async (req, res) => {
  try {
    const payout = await Payout.findByIdAndDelete(req.params.id);
    if (!payout) {
      return res.status(404).json({ message: 'Payout not found' });
    }
    res.json({ message: 'Payout record deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Bulk delete payouts
router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ message: 'Invalid payload, expected an array of ids' });
    }
    await Payout.deleteMany({ _id: { $in: ids } });
    res.json({ message: 'Payout records deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Calculate payout preview
router.post('/preview', async (req, res) => {
  try {
    const { employeeId, startDate, endDate } = req.body;

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Get attendance records for date range
    const attendance = await Attendance.find({
      employee: employeeId,
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      },
      present: true
    });

    // One full working day = 8 hours, so the hourly rate is daily salary / 8.
    const HOURS_PER_DAY = 8;
    const hourlyRate = employee.baseDailySalary / HOURS_PER_DAY;

    // Count of present days (kept for reference/display).
    const totalDaysWorked = attendance.length;

    // Sum of the ACTUAL hours worked across all present days.
    // This is what now drives the pay.
    const totalHoursWorked = attendance.reduce((total, record) =>
      total + (record.workHours || 0), 0);

    const overtimeHours = attendance.reduce((total, record) =>
      total + (record.overtime || 0), 0);
      
    const totalAdvancePayment = attendance.reduce((total, record) =>
      total + (record.advancePayment || 0), 0);

    // Pay is based on real hours worked, not just the number of days.
    const totalAmount = totalHoursWorked * hourlyRate;
    const overtimeAmount = overtimeHours * hourlyRate;

    res.json({
      employeeId,
      startDate,
      endDate,
      totalDaysWorked,
      totalHoursWorked,
      hourlyRate,
      totalAmount,
      overtimeHours,
      overtimeAmount,
      totalAdvancePayment,
      grossAmount: totalAmount + overtimeAmount
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
