const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  baseDailySalary: {
    type: Number,
    required: true,
  },
  joiningDate: {
    type: Date,
    default: Date.now,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  contactNumber: {
    type: String,
  },
  address: {
    type: String,
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Employee', employeeSchema);