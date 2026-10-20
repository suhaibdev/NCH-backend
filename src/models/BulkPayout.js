const mongoose = require("mongoose");

const employeePayoutLineSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    employeeName: { type: String, required: true, trim: true },
    totalDaysWorked: { type: Number, required: true, min: 0 },
    totalHoursWorked: { type: Number, required: true, min: 0 },
    fullWorkingDays: { type: Number, required: true, min: 0 },
    remainingWorkingHours: { type: Number, required: true, min: 0 },
    overtimeHours: { type: Number, required: true, min: 0 },
    dailySalary: { type: Number, required: true, min: 0 },
    hourlyRate: { type: Number, required: true, min: 0 },
    baseSalary: { type: Number, required: true, min: 0 },
    overtimeAmount: { type: Number, required: true, min: 0 },
    grossSalary: { type: Number, required: true, min: 0 },
    outstandingAdvanceBefore: { type: Number, required: true, min: 0 },
    advanceDeducted: { type: Number, required: true, min: 0 },
    outstandingAdvanceAfter: { type: Number, required: true, min: 0 },
    deductions: { type: Number, required: true, min: 0 },
    netSalary: { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ["cash", "upi", "bank", "cheque"],
      required: true,
    },
  },
  { _id: false }
);

const bulkPayoutSchema = new mongoose.Schema(
  {
    payoutNumber: { type: String, required: true, unique: true, trim: true },
    payrollPeriod: {
      code: { type: String, default: "" },
      name: { type: String, default: "" },
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    paidOn: { type: Date, required: true },
    employeeCount: { type: Number, required: true, min: 1 },
    totalGross: { type: Number, required: true, min: 0 },
    totalAdvanceCut: { type: Number, required: true, min: 0 },
    totalAdvanceLeft: { type: Number, required: true, min: 0 },
    totalOtherDeduction: { type: Number, required: true, min: 0 },
    totalNetPaid: { type: Number, required: true },
    employees: { type: [employeePayoutLineSchema], required: true },
    generatedBy: { type: String, default: "Admin" },
  },
  { timestamps: true }
);

bulkPayoutSchema.index({ paidOn: -1, _id: -1 });
bulkPayoutSchema.index({ startDate: -1, endDate: -1 });
bulkPayoutSchema.index({ "employees.employee": 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model("BulkPayout", bulkPayoutSchema);
