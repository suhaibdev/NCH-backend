const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Attendance = require("../models/Attendance");
const Employee = require("../models/Employee");
const { isPresentByWorkHours, STANDARD_WORK_HOURS, toFiniteNumber } = require("../utils/payroll");

const hasValidWorkHours = (value) => Number.isFinite(value) && value >= 0 && value <= 8;

const hasValidOvertime = (value) => Number.isFinite(value) && value >= 0 && value <= 24;

const hasValidAdvance = (value) => Number.isFinite(value) && value >= 0;

const getDateOnlyBounds = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }

  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);

  return { date, nextDate };
};

const getBusinessToday = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${value.year}-${value.month}-${value.day}`;
};

const isFutureAttendanceDate = (bounds) => bounds.date.toISOString().slice(0, 10) > getBusinessToday();

const futureAttendanceDateResponse = (res) =>
  res.status(400).json({
    code: "FUTURE_ATTENDANCE_DATE",
    message: "Attendance cannot be marked for a future date.",
  });

const normalizeAttendanceValues = ({ present, workHours, overtime, advancePayment }) => {
  if (workHours === "" || workHours === undefined || workHours === null) {
    return null;
  }

  const isMarkedPresent = present !== false;
  const hours = isMarkedPresent ? toFiniteNumber(workHours, Number.NaN) : 0;
  const ot = isMarkedPresent
    ? overtime === "" || overtime === undefined || overtime === null
      ? 0
      : toFiniteNumber(overtime, Number.NaN)
    : 0;
  const advance =
    advancePayment === "" || advancePayment === undefined || advancePayment === null
      ? 0
      : toFiniteNumber(advancePayment, Number.NaN);

  if (!hasValidWorkHours(hours) || !hasValidOvertime(ot) || !hasValidAdvance(advance)) {
    return null;
  }

  return {
    present: isPresentByWorkHours(hours),
    workHours: hours,
    overtime: ot,
    advancePayment: advance,
  };
};

// Get all attendance records
router.get("/", async (req, res) => {
  try {
    const attendance = await Attendance.find().populate("employee", "name").sort({ date: -1 });
    res.json(attendance);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get attendance by date range
router.get("/range", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const attendance = await Attendance.find({
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    }).populate("employee", "name");
    res.json(attendance);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Load active employees and their saved attendance for one date in one request.
router.get("/bulk", async (req, res) => {
  const bounds = getDateOnlyBounds(req.query.date);
  if (!bounds) {
    return res.status(400).json({ message: "A valid date is required." });
  }

  try {
    const [employees, records] = await Promise.all([
      Employee.find({ isActive: true }).sort({ name: 1 }).lean(),
      Attendance.find({
        date: { $gte: bounds.date, $lt: bounds.nextDate },
      }).lean(),
    ]);

    res.json({
      defaultWorkHours: STANDARD_WORK_HOURS,
      employees,
      records,
    });
  } catch (err) {
    res.status(500).json({ message: "Unable to load bulk attendance." });
  }
});

// Get attendance by employee
router.get("/employee/:employeeId", async (req, res) => {
  try {
    const attendance = await Attendance.find({
      employee: req.params.employeeId,
    })
      .populate("employee", "name")
      .sort({ date: -1 });
    res.json(attendance);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Mark attendance for an employee
router.post("/", async (req, res) => {
  try {
    const { employeeId, date, present, workHours, overtime, advancePayment, notes } = req.body;
    // Validation

    if (!employeeId || !date) {
      return res.status(400).json({
        message: "Employee and date are required.",
      });
    }

    const bounds = getDateOnlyBounds(date);
    if (!bounds) {
      return res.status(400).json({ message: "A valid date is required." });
    }
    if (isFutureAttendanceDate(bounds)) {
      return futureAttendanceDateResponse(res);
    }

    const hours =
      workHours === "" || workHours === undefined || workHours === null ? 8 : Number(workHours);
    const ot = Number(overtime ?? 0);
    const advance = Number(advancePayment ?? 0);

    if (!hasValidWorkHours(hours)) {
      return res.status(400).json({
        message: "Work hours must be between 0 and 8.",
      });
    }

    if (!hasValidOvertime(ot)) {
      return res.status(400).json({
        message: "Overtime must be between 0 and 24.",
      });
    }

    if (!hasValidAdvance(advance)) {
      return res.status(400).json({
        message: "Advance payment cannot be negative.",
      });
    }

    // Check if employee exists
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Check if attendance already marked for this date
    const existingAttendance = await Attendance.findOne({
      employee: employeeId,
      date: {
        $gte: bounds.date,
        $lt: bounds.nextDate,
      },
    });

    if (existingAttendance) {
      return res.status(400).json({
        message: "Attendance already marked for this date",
      });
    }

    const attendance = new Attendance({
      employee: employeeId,
      date: bounds.date,
      // A zero-hour record is always absent, regardless of a client flag.
      present: isPresentByWorkHours(hours),
      // Only fall back to 8 when the value is truly missing/blank.
      // (Using "workHours || 8" would wrongly turn a real 0 — an absent
      //  employee — back into 8, because 0 is "falsy" in JavaScript.)
      workHours: hours,
      overtime: ot,
      advancePayment: advance,
      notes: notes,
    });

    const newAttendance = await attendance.save();
    await newAttendance.populate("employee", "name");
    res.status(201).json(newAttendance);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update attendance
router.put("/:id", async (req, res) => {
  try {
    const attendance = await Attendance.findById(req.params.id);
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    const bounds = getDateOnlyBounds(attendance.date.toISOString().slice(0, 10));
    if (bounds && isFutureAttendanceDate(bounds)) {
      return futureAttendanceDateResponse(res);
    }

    const workHours =
      req.body.workHours === undefined
        ? Number(attendance.workHours || 0)
        : toFiniteNumber(req.body.workHours, Number.NaN);
    const overtime =
      req.body.overtime === undefined
        ? Number(attendance.overtime || 0)
        : toFiniteNumber(req.body.overtime, Number.NaN);
    const advancePayment =
      req.body.advancePayment === undefined
        ? Number(attendance.advancePayment || 0)
        : toFiniteNumber(req.body.advancePayment, Number.NaN);

    if (!hasValidWorkHours(workHours)) {
      return res.status(400).json({ message: "Work hours must be between 0 and 8." });
    }
    if (!hasValidOvertime(overtime)) {
      return res.status(400).json({ message: "Overtime must be between 0 and 24." });
    }
    if (!hasValidAdvance(advancePayment)) {
      return res.status(400).json({ message: "Advance payment cannot be negative." });
    }

    attendance.workHours = workHours;
    attendance.overtime = overtime;
    attendance.advancePayment = advancePayment;
    attendance.present = isPresentByWorkHours(workHours);

    if (req.body.notes !== undefined) {
      attendance.notes = req.body.notes;
    }

    const updatedAttendance = await attendance.save();
    await updatedAttendance.populate("employee", "name");
    res.json(updatedAttendance);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete attendance
router.delete("/:id", async (req, res) => {
  try {
    const attendance = await Attendance.findById(req.params.id);
    if (!attendance) {
      return res.status(404).json({ message: "Attendance record not found" });
    }
    await attendance.deleteOne();
    res.json({ message: "Attendance record deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Bulk mark attendance
router.post("/bulk", async (req, res) => {
  const bounds = getDateOnlyBounds(req.body.date);
  const records = Array.isArray(req.body.records) ? req.body.records : [];

  if (!bounds || records.length === 0) {
    return res
      .status(400)
      .json({ message: "A valid date and at least one attendance record are required." });
  }

  if (isFutureAttendanceDate(bounds)) {
    return futureAttendanceDateResponse(res);
  }

  const employeeIds = records.map((record) => record?.employeeId);
  if (
    employeeIds.some((id) => !mongoose.isValidObjectId(id)) ||
    new Set(employeeIds.map(String)).size !== employeeIds.length
  ) {
    return res.status(400).json({ message: "Each selected employee must appear once." });
  }

  const normalizedRecords = records.map((record) => ({
    employeeId: String(record.employeeId),
    values: normalizeAttendanceValues(record),
    notes: typeof record.notes === "string" ? record.notes.trim() : "",
  }));

  if (normalizedRecords.some((record) => !record.values)) {
    return res.status(400).json({
      message:
        "Each bulk attendance record needs valid status, work hours, overtime, and advance values.",
    });
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const [employees, existingRecords] = await Promise.all([
        Employee.find({ _id: { $in: employeeIds }, isActive: true })
          .session(session)
          .lean(),
        Attendance.find({
          employee: { $in: employeeIds },
          date: { $gte: bounds.date, $lt: bounds.nextDate },
        })
          .session(session)
          .lean(),
      ]);

      if (employees.length !== employeeIds.length) {
        throw new Error("One or more selected employees are no longer active.");
      }

      const existingByEmployee = new Map(
        existingRecords.map((record) => [String(record.employee), record])
      );
      const operations = normalizedRecords.map(({ employeeId, values, notes }) => {
        const attendanceValues = { ...values, notes };
        const existing = existingByEmployee.get(employeeId);
        return existing
          ? { updateOne: { filter: { _id: existing._id }, update: { $set: attendanceValues } } }
          : {
              insertOne: {
                document: { employee: employeeId, date: bounds.date, ...attendanceValues },
              },
            };
      });

      await Attendance.bulkWrite(operations, { session, ordered: true });
      const savedRecords = await Attendance.find({
        employee: { $in: employeeIds },
        date: { $gte: bounds.date, $lt: bounds.nextDate },
      })
        .populate("employee", "name")
        .session(session);

      result = {
        created: operations.filter((operation) => operation.insertOne).length,
        updated: operations.filter((operation) => operation.updateOne).length,
        failed: 0,
        records: savedRecords,
      };
    });

    res.status(200).json(result);
  } catch (err) {
    const knownMessage =
      err.message === "One or more selected employees are no longer active."
        ? err.message
        : "Unable to save bulk attendance.";
    res.status(400).json({ message: knownMessage });
  } finally {
    await session.endSession();
  }
});
// =======================================
// Outstanding Advance Report
// =======================================

router.get("/advance-summary", async (req, res) => {
  try {
    const summary = await Attendance.aggregate([
      {
        $match: {
          advancePayment: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: "$employee",
          totalAdvance: {
            $sum: "$advancePayment",
          },
        },
      },
      {
        $lookup: {
          from: "employees",
          localField: "_id",
          foreignField: "_id",
          as: "employee",
        },
      },
      {
        $unwind: "$employee",
      },
      {
        $project: {
          employeeId: "$employee._id",
          employeeName: "$employee.name",
          totalAdvance: 1,
        },
      },
      {
        $sort: {
          employeeName: 1,
        },
      },
    ]);

    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Unable to load advance summary.",
    });
  }
});

module.exports = router;
