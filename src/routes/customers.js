// File: server/routes/customers.js
const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');

// Map known Mongoose/Mongo errors to safe client responses; never leak stack traces.
const handleError = (err, res) => {
  if (res.headersSent) return;
  if (err && err.code === 11000) {
    return res.status(409).json({ message: 'A customer with this email already exists.' });
  }
  if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
    return res.status(400).json({ message: 'Invalid customer data.' });
  }
  console.error('CUSTOMERS ROUTE ERROR:', err);
  return res.status(500).json({ message: 'Internal server error.' });
};

// Local to this file only.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => handleError(err, res));

// Get all customers
router.get('/', asyncHandler(async (req, res) => {
  const customers = await Customer.find();
  res.json(customers);
}));

// Add a new customer
router.post('/', asyncHandler(async (req, res) => {
  const { name, email, contactNumber, gst } = req.body;
  const newCustomer = new Customer({ name, email, contactNumber, gst });
  await newCustomer.save();
  res.json(newCustomer);
}));

// Add a customer order
router.post('/:id/order', asyncHandler(async (req, res) => {
  const { product, quantity } = req.body || {};
  if (typeof product !== 'string' || product.trim() === '') {
    return res.status(400).json({ message: 'Product is required.' });
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ message: 'Quantity must be a whole number greater than 0.' });
  }
  const customer = await Customer.findById(req.params.id);
  if (customer) {
    customer.orders.push({ product: product.trim(), quantity });
    customer.stock += quantity;
    await customer.save();
    res.json(customer);
  } else {
    res.status(404).json({ message: 'Customer not found' });
  }
}));

// Update a customer
router.put('/:id', asyncHandler(async (req, res) => {
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
}));

// Delete a customer
router.delete('/:id', asyncHandler(async (req, res) => {
  const customer = await Customer.findByIdAndDelete(req.params.id);
  if (customer) {
    res.json({ message: 'Customer deleted' });
  } else {
    res.status(404).json({ message: 'Customer not found' });
  }
}));

module.exports = router;
