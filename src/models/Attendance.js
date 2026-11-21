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
  min: 0,
  max: 24,
},

 overtime: {
   type: Number,
   default: 0,
   min: 0,
   max: 24,
 },

 advancePayment: {
   type: Number,
   default: 0,
  min: 0,
 },
 notes: {
  type: String,
  default: '',
  trim: true,
 },
}, {
  timestamps: true
});

// Ensure one attendance record per employee per day
attendanceSchema.index({ employee: 1, date: 1 }, { unique: true });
// Supports date-only range queries (register, bulk load, dashboard, payout preview).
attendanceSchema.index({ date: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);