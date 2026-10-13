const express = require("express");
const mongoose = require("mongoose");
const Washer = require("../models/Washer");
const { parseMoneyToPaise } = require("../utils/washing");

const router = express.Router();

const parsePage = (value, fallback, maximum) => {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
};

const cleanText = (value, field, maximum, { required = false } = {}) => {
  if (value === undefined || value === null) return required ? { valid: false, message: `${field} is required.` } : { valid: true, value: "" };
  if (typeof value !== "string") return { valid: false, message: `${field} must be text.` };
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (required && !cleaned) return { valid: false, message: `${field} is required.` };
  if (cleaned.length > maximum) return { valid: false, message: `${field} must be ${maximum} characters or fewer.` };
  return { valid: true, value: cleaned };
};

const validatedPayload = (body, { partial = false } = {}) => {
  const result = {};
  const fields = [
    ["name", "Washer name", 150, true],
    ["phone", "Contact number", 10, false],
    ["address", "Address", 500, false],
    ["notes", "Notes", 1000, false],
  ];
  for (const [key, label, maximum, required] of fields) {
    if (partial && body[key] === undefined) continue;
    const checked = cleanText(body[key], label, maximum, { required });
    if (!checked.valid) return checked;
    result[key] = checked.value;
  }
  if (result.phone !== undefined && result.phone && !/^\d{10}$/.test(result.phone)) return { valid: false, message: "Contact number must be exactly 10 digits." };
  if (!partial || body.defaultRatePerPiece !== undefined) {
    const rate = parseMoneyToPaise(body.defaultRatePerPiece ?? "0");
    if (!rate.valid) return rate;
    result.defaultRatePerPiecePaise = rate.value;
  }
  if (!partial || body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return { valid: false, message: "Active status must be true or false." };
    result.isActive = body.isActive;
  }
  return { valid: true, value: result };
};

const formatWasher = (washer) => ({
  ...washer,
  defaultRatePerPiece: (washer.defaultRatePerPiecePaise / 100).toFixed(2),
});

router.get("/", async (req, res) => {
  try {
    const page = parsePage(req.query.page, 1, 1000000);
    const limit = parsePage(req.query.limit, 20, 100);
    if (!page || !limit) return res.status(400).json({ message: "Page and limit must be positive integers; limit cannot exceed 100." });
    const search = String(req.query.search || "").trim().slice(0, 100);
    const query = search ? { $or: [{ name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, { phone: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }] } : {};
    if (req.query.active === "true") query.isActive = true;
    if (req.query.active === "false") query.isActive = false;
    const [items, totalItems] = await Promise.all([
      Washer.find(query).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Washer.countDocuments(query),
    ]);
    return res.json({ items: items.map(formatWasher), pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
  } catch (err) {
    console.error("GET WASHERS ERROR:", err);
    return res.status(500).json({ message: "Unable to load washers." });
  }
});

router.get("/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid washer ID." });
  try {
    const washer = await Washer.findById(req.params.id).lean();
    if (!washer) return res.status(404).json({ message: "Washer not found." });
    return res.json({ washer: formatWasher(washer) });
  } catch (err) {
    console.error("GET WASHER ERROR:", err);
    return res.status(500).json({ message: "Unable to load washer." });
  }
});

router.post("/", async (req, res) => {
  const checked = validatedPayload(req.body || {});
  if (!checked.valid) return res.status(400).json({ message: checked.message });
  try {
    const washer = await Washer.create(checked.value);
    return res.status(201).json({ message: "Washer created successfully.", washer: formatWasher(washer.toObject()) });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ message: "A washer with this name already exists." });
    console.error("CREATE WASHER ERROR:", err);
    return res.status(500).json({ message: "Unable to create washer." });
  }
});

router.put("/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid washer ID." });
  const checked = validatedPayload(req.body || {}, { partial: true });
  if (!checked.valid) return res.status(400).json({ message: checked.message });
  if (!Object.keys(checked.value).length) return res.status(400).json({ message: "Provide at least one washer field to update." });
  try {
    const washer = await Washer.findById(req.params.id);
    if (!washer) return res.status(404).json({ message: "Washer not found." });
    Object.assign(washer, checked.value);
    await washer.save();
    return res.json({ message: "Washer updated successfully.", washer: formatWasher(washer.toObject()) });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ message: "A washer with this name already exists." });
    console.error("UPDATE WASHER ERROR:", err);
    return res.status(500).json({ message: "Unable to update washer." });
  }
});

router.validation = Object.freeze({ validatedPayload, formatWasher });
module.exports = router;
