const mongoose = require('mongoose');

const EmployeeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  contactNumber: {
    type: String,
  },
  role: {
    type: String,
    required: true,
  },
}, { timestamps: true });

module.exports = mongoose.model('Employee', EmployeeSchema);
