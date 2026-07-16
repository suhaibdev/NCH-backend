const express = require('express');
const router = express.Router();

const Employee = require('../models/Employee');
const Customer = require('../models/Customer');
const Attendance = require('../models/Attendance');
const Payout = require('../models/Payout');

router.get('/', async (req, res) => {
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
      advanceSummary,
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
              $sum: '$amount',
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
              $sum: '$advancePayment',
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
        .select('name baseDailySalary'),

      Attendance.aggregate([
        {
          $match: {
            advancePayment: {
              $gt: 0,
            },
          },
        },
        {
          $group: {
            _id: '$employee',
            totalAdvance: {
              $sum: '$advancePayment',
            },
          },
        },
        {
          $lookup: {
            from: 'employees',
            localField: '_id',
            foreignField: '_id',
            as: 'employee',
          },
        },
        {
          $unwind: '$employee',
        },
        {
          $match: {
            'employee.isActive': true,
          },
        },
        {
          $project: {
            _id: 0,
            employeeId: '$employee._id',
            employeeName: '$employee.name',
            totalAdvance: 1,
          },
        },
        {
          $sort: {
            totalAdvance: -1,
          },
        },
      ]),

    ]);

    const salaryCycle = (() => {
      const day = today.getDate();

      if (day <= 10) {
        return {
          title: '1 - 10',
          currentDay: day,
          totalDays: 10,
        };
      }

      if (day <= 20) {
        return {
          title: '11 - 20',
          currentDay: day - 10,
          totalDays: 10,
        };
      }

      const lastDay = new Date(
        today.getFullYear(),
        today.getMonth() + 1,
        0
      ).getDate();

      return {
        title: `21 - ${lastDay}`,
        currentDay: day - 20,
        totalDays: lastDay - 20,
      };
    })();

    res.json({

      totalEmployees,

      activeEmployees,

      totalCustomers,

      attendanceToday: presentToday,

      absentToday:
        activeEmployees - presentToday < 0
          ? 0
          : activeEmployees - presentToday,

      attendanceMarked,

      monthSalary:
        monthSalary.length > 0
          ? monthSalary[0].total
          : 0,

      monthAdvance:
        monthAdvance.length > 0
          ? monthAdvance[0].total
          : 0,

      salaryCycle,

      recentEmployees,

      advanceSummary,

    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: 'Failed to load dashboard',
    });

  }
});

module.exports = router;