const express = require("express");
const router = express.Router();

const Employee = require("../models/Employee");
const Customer = require("../models/Customer");
const Attendance = require("../models/Attendance");
const Payout = require("../models/Payout");
const BulkPayout = require("../models/BulkPayout");
const {
  buildDashboardResponse,
  getAttendanceMonthStart,
  getMonthBounds,
  sumMonthSalary,
} = require("../utils/dashboardResponse");
const { sendServerError } = require("../utils/httpErrors");

router.get("/", async (req, res) => {
  try {
    const today = new Date();

    const startOfToday = new Date(today);
    startOfToday.setHours(0, 0, 0, 0);

    const endOfToday = new Date(today);
    endOfToday.setHours(23, 59, 59, 999);

    // Month advance: IST month start at UTC midnight (attendance dates are stored that way).
    const startOfMonth = getAttendanceMonthStart(today);
    // Salary paid this month: IST month bounds, independent of server time zone.
    const paidBounds = getMonthBounds(today);
    const paidRange = { $gte: paidBounds.start, $lt: paidBounds.end };

    const [
      totalEmployees,
      activeEmployees,
      totalCustomers,
      presentToday,
      attendanceMarked,
      monthSinglePaid,
      monthBulkPaid,
      monthAdvance,
      recentEmployees,
    ] = await Promise.all([
      Employee.countDocuments(),

      Employee.countDocuments({
        isActive: true,
      }),

      Customer.countDocuments(),

      Attendance.countDocuments({
        present: true,
        date: {
          $gte: startOfToday,
          $lte: endOfToday,
        },
      }),

      Attendance.countDocuments({
        date: {
          $gte: startOfToday,
          $lte: endOfToday,
        },
      }),

      Payout.aggregate([
        { $match: { status: "Paid", paidOn: paidRange } },
        { $group: { _id: null, total: { $sum: "$netSalary" } } },
      ]),

      BulkPayout.aggregate([
        { $match: { paidOn: paidRange } },
        { $group: { _id: null, total: { $sum: "$totalNetPaid" } } },
      ]),

      Attendance.aggregate([
        {
          $match: {
            date: {
              $gte: startOfMonth,
            },
            advancePayment: {
              $gt: 0,
            },
          },
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: "$advancePayment",
            },
          },
        },
      ]),

      Employee.find({
        isActive: true,
      })
        .sort({
          createdAt: -1,
        })
        .limit(5)
        .select("name baseDailySalary")
        .lean(),
    ]);

    res.json(
      buildDashboardResponse({
        totalEmployees,
        activeEmployees,
        totalCustomers,
        presentToday,
        attendanceMarked,
        monthSalary: [{ total: sumMonthSalary(monthSinglePaid, monthBulkPaid) }],
        monthAdvance,
        recentEmployees,
      })
    );
  } catch (err) {
    sendServerError(res, "GET DASHBOARD", err, "Failed to load dashboard");
  }
});

module.exports = router;
