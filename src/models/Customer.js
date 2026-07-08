// File: server/models/Customer.js
const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  contactNumber: { type: Number },
  gst: { type: String },
  stock: { type: Number, default: 0 },
  orders: [
    {
      product: String,
      quantity: Number,
      date: { type: Date, default: Date.now }
    }
  ]
});

module.exports = mongoose.model('Customer', customerSchema);