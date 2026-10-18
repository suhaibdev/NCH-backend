const express = require("express");
const router = express.Router();

const Employee = require("../models/Employee");
const Customer = require("../models/Customer");
const Attendance = require("../models/Attendance");
const Payout = require("../models/Payout");
const { buildDashboardResponse } = require("../utils/dashboardResponse");

router.get("/", async (req, res) => {
  try {
    const today = new Date();

    const startOfToday = new Date(today);
    startOfToday.setHours(0, 0, 0, 0);

    const endOfToday = new Date(today);
    endOfToday.setHours(23, 59, 59, 999);

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [
      totalEmployees,
      activeEmployees,
      totalCustomers,
      presentToday,
      attendanceMarked,
      monthSalary,
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
        {
          $match: {
            createdAt: {
              $gte: startOfMonth,
            },
          },
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: "$amount",
            },
          },
        },
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
        monthSalary,
        monthAdvance,
        recentEmployees,
      })
    );
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed to load dashboard",
    });
  }
});

module.exports = router;
