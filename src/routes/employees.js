const express = require('express');
const { sendServerError } = require("../utils/httpErrors");
const router = express.Router();
const Employee = require('../models/Employee');
const { sendListResponse } = require('../utils/listQuery');

// =====================================
// Get all employees
// =====================================
// Legacy callers get the full array (capped); ?page/?limit returns a paged envelope.
const EMPLOYEE_LIST_CAP = 1000;

router.get('/', async (req, res) => {
  try {
    await sendListResponse(
      res,
      req.query,
      { cap: EMPLOYEE_LIST_CAP },
      () => Employee.find().sort({ _id: 1 }),
      () => Employee.countDocuments()
    );
  } catch (err) {
    sendServerError(res, "GET EMPLOYEES", err);
  }
});

// =====================================
// Get active employees
// =====================================
router.get('/status/active', async (req, res) => {
  try {
    const activeEmployees = await Employee.find({ isActive: true });
    res.json(activeEmployees);
  } catch (err) {
    sendServerError(res, "GET ACTIVE EMPLOYEES", err);
  }
});

// =====================================
// Get single employee
// =====================================
router.get('/:id', async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);

    if (!employee) {
      return res.status(404).json({
        message: 'Employee not found',
      });
    }

    res.json(employee);
  } catch (err) {
    sendServerError(res, "GET EMPLOYEE", err);
  }
});

// =====================================
// Add new employee
// =====================================
router.post('/', async (req, res) => {
  const employee = new Employee({
    name: req.body.name,
    baseDailySalary: req.body.baseDailySalary,
    contactNumber: req.body.contactNumber,
    address: req.body.address,
  });

  try {
    const newEmployee = await employee.save();
    res.status(201).json(newEmployee);
  } catch (err) {
    res.status(400).json({
      message: err.message,
    });
  }
});

// =====================================
// Update employee
// =====================================
router.put('/:id', async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);

    if (!employee) {
      return res.status(404).json({
        message: 'Employee not found',
      });
    }

    const updateFields = [
      'name',
      'workType',
      'baseDailySalary',
      'salaryPayoutFrequency',
      'isActive',
      'contactNumber',
      'address',
    ];

    updateFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        employee[field] = req.body[field];
      }
    });

    const updatedEmployee = await employee.save();

    res.json(updatedEmployee);
  } catch (err) {
    res.status(400).json({
      message: err.message,
    });
  }
});

// =====================================
// Soft Delete Employee
// =====================================
router.delete('/:id', async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);

    if (!employee) {
      return res.status(404).json({
        message: 'Employee not found',
      });
    }

    employee.isActive = false;

    const updatedEmployee = await employee.save();

    res.json(updatedEmployee);
  } catch (err) {
    sendServerError(res, "DELETE EMPLOYEE", err);
  }
});

module.exports = router;