const mongoose = require("mongoose");

const payoutSchema = new mongoose.Schema(
{
    employee: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
        required: true,
    },

    // Salary Period
    startDate: {
        type: Date,
        required: true,
    },

    endDate: {
        type: Date,
        required: true,
    },

    // Attendance
    totalDaysWorked: {
        type: Number,
        default: 0,
    },

    totalHoursWorked: {
        type: Number,
        default: 0,
    },

    overtimeHours: {
        type: Number,
        default: 0,
    },

    // Salary Details
    dailySalary: {
        type: Number,
        default: 0,
    },

    hourlyRate: {
        type: Number,
        default: 0,
    },

    baseSalary: {
        type: Number,
        default: 0,
    },

    overtimeAmount: {
        type: Number,
        default: 0,
    },

    grossSalary: {
        type: Number,
        default: 0,
    },

    // Old field (keep for compatibility)
    totalAmount: {
        type: Number,
        default: 0,
    },

    // Advance
    outstandingAdvanceBefore: {
        type: Number,
        default: 0,
    },

    advanceDeducted: {
        type: Number,
        default: 0,
        min: 0,
    },

    outstandingAdvanceAfter: {
        type: Number,
        default: 0,
    },

    // Other deduction
    deductions: {
        type: Number,
        default: 0,
        min: 0,
    },

    // Final salary
    netSalary: {
        type: Number,
        default: 0,
    },

    // Payment
    paymentMethod: {
        type: String,
        enum: ["cash", "bank_transfer", "upi"],
        default: "cash",
    },

    status: {
        type: String,
        enum: ["pending", "paid", "cancelled"],
        default: "pending",
    },

    paidOn: {
        type: Date,
        default: Date.now,
    },

    // Extra
    remarks: {
        type: String,
        default: "",
        trim: true,
    },

    generatedBy: {
        type: String,
        default: "Admin",
    },

    printed: {
        type: Boolean,
        default: false,
    },

    salarySlipNumber: {
        type: String,
        default: "",
    }

},
{
    timestamps: true,
});

module.exports = mongoose.model("Payout", payoutSchema);