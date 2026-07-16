const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    baseDailySalary: {
      type: Number,
      required: true,
      min: 0,
    },

    joiningDate: {
      type: Date,
      default: Date.now,
    },

    contactNumber: {
      type: String,
      default: '',
    },

    address: {
      type: String,
      default: '',
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // Running balance of salary advances
    totalAdvance: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model('Employee', employeeSchema);