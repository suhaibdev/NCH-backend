const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },

  startDate: {
    type: Date,
    required: true,
  },

  endDate: {
    type: Date,
    required: true,
  },

  totalDaysWorked: {
    type: Number,
    required: true,
  },

  totalHoursWorked: {
    type: Number,
    default: 0,
  },

  totalAmount: {
    type: Number,
    required: true,
  },

  overtimeHours: {
    type: Number,
    default: 0,
  },

  overtimeAmount: {
    type: Number,
    default: 0,
  },

  // Manual advance deduction
  advanceDeducted: {
    type: Number,
    default: 0,
    min: 0,
  },

  // Other deductions
  deductions: {
    type: Number,
    default: 0,
    min: 0,
  },

  paymentMethod: {
    type: String,
    enum: ['cash', 'bank_transfer'],
    default: 'cash',
  },

  status: {
    type: String,
    enum: ['pending', 'paid', 'cancelled'],
    default: 'pending',
  },

  paidOn: {
    type: Date,
    default: Date.now,
  }

}, {
  timestamps: true,
});

module.exports = mongoose.model('Payout', payoutSchema);