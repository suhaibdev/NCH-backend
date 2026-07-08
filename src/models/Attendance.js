const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true,
  },
  date: {
    type: Date,
    required: true,
  },
  present: {
    type: Boolean,
    default: true,
  },
  workHours: {
    type: Number,
    default: 8,
  },
  overtime: {
    type: Number,
    default: 0,
  },
  advancePayment: {
    type: Number,
    default: 0,
  },
  notes: {
    type: String,
  }
}, {
  timestamps: true
});

// Ensure one attendance record per employee per day
attendanceSchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);