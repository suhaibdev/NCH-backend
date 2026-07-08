const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');

// GET all customers
router.get('/', async (req, res) => {
  try {
    const customers = await Customer.find();
    res.json(customers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET a single customer
router.get('/:id', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST a new customer
router.post('/', async (req, res) => {
  const customer = new Customer({
    name: req.body.name,
    email: req.body.email,
    contactNumber: req.body.contactNumber,
    gst: req.body.gst,
  });

  try {
    const newCustomer = await customer.save();
    res.status(201).json(newCustomer);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT update a customer
router.put('/:id', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    
    if (req.body.name) customer.name = req.body.name;
    if (req.body.email) customer.email = req.body.email;
    if (req.body.contactNumber) customer.contactNumber = req.body.contactNumber;
    if (req.body.gst) customer.gst = req.body.gst;
    
    const updatedCustomer = await customer.save();
    res.json(updatedCustomer);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE a customer
router.delete('/:id', async (req, res) => {
  try {
    const customer = await Customer.findByIdAndDelete(req.params.id);
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    res.json({ message: 'Deleted Customer' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
