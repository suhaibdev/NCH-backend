// File: server/routes/customers.js
const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');

// Get all customers
router.get('/', async (req, res) => {
  const customers = await Customer.find();
  res.json(customers);
});

// Add a new customer
router.post('/', async (req, res) => {
  const { name, email, contactNumber, gst } = req.body;
  const newCustomer = new Customer({ name, email, contactNumber, gst });
  await newCustomer.save();
  res.json(newCustomer);
});

// Add a customer order
router.post('/:id/order', async (req, res) => {
  const { product, quantity } = req.body;
  const customer = await Customer.findById(req.params.id);
  if (customer) {
    customer.orders.push({ product, quantity });
    customer.stock += quantity;
    await customer.save();
    res.json(customer);
  } else {
    res.status(404).json({ message: 'Customer not found' });
  }
});

// Update a customer
router.put('/:id', async (req, res) => {
  const { name, email, contactNumber, gst } = req.body;
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { name, email, contactNumber, gst },
    { new: true }
  );
  if (customer) {
    res.json(customer);
  } else {
    res.status(404).json({ message: 'Customer not found' });
  }
});

// Delete a customer
router.delete('/:id', async (req, res) => {
  const customer = await Customer.findByIdAndDelete(req.params.id);
  if (customer) {
    res.json({ message: 'Customer deleted' });
  } else {
    res.status(404).json({ message: 'Customer not found' });
  }
});

module.exports = router;