const express = require("express");
const mongoose = require("mongoose");

const Supplier = require("../models/Supplier");

const router = express.Router();

const FIELD_LIMITS = {
  name: 150,
  contactPerson: 100,
  phone: 30,
  email: 160,
  address: 500,
  gstNumber: 30,
  notes: 1000,
};


const escapeRegex = (value) =>
  String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );


const cleanText = (
  value,
  field,
  { required = false } = {}
) => {
  if (
    value === undefined ||
    value === null
  ) {
    if (required) {
      return {
        valid: false,
        message: `${field} is required.`,
      };
    }

    return {
      valid: true,
      value: "",
    };
  }

  if (typeof value !== "string") {
    return {
      valid: false,
      message: `${field} must be text.`,
    };
  }

  const cleaned = value.trim();

  if (required && !cleaned) {
    return {
      valid: false,
      message: `${field} is required.`,
    };
  }

  if (cleaned.length > FIELD_LIMITS[field]) {
    return {
      valid: false,
      message: `${field} must be ${FIELD_LIMITS[field]} characters or fewer.`,
    };
  }

  return {
    valid: true,
    value:
      field === "name"
        ? cleaned.replace(/\s+/g, " ")
        : cleaned,
  };
};


const getSupplierPayload = (body) => {
  const fields = [
    "name",
    "contactPerson",
    "phone",
    "email",
    "address",
    "gstNumber",
    "notes",
  ];

  const payload = {};

  for (const field of fields) {
    const result = cleanText(
      body[field],
      field,
      { required: field === "name" }
    );

    if (!result.valid) {
      return result;
    }

    payload[field] = result.value;
  }

  if (
    payload.email &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      payload.email
    )
  ) {
    return {
      valid: false,
      message: "Please enter a valid email address.",
    };
  }

  return {
    valid: true,
    value: payload,
  };
};


const parsePositiveInteger = (
  value,
  fallback,
  maximum
) => {
  if (value === undefined) {
    return {
      valid: true,
      value: fallback,
    };
  }

  if (!/^\d+$/.test(String(value))) {
    return {
      valid: false,
    };
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > maximum
  ) {
    return {
      valid: false,
    };
  }

  return {
    valid: true,
    value: parsed,
  };
};


const isDuplicateKeyError = (err) =>
  err?.code === 11000;


/* ==========================================================
   GET SUPPLIERS

   GET /api/suppliers?search=&page=1&limit=25
========================================================== */

router.get(
  "/",
  async (req, res) => {
    try {
      const pageResult = parsePositiveInteger(
        req.query.page,
        1,
        1000000
      );

      const limitResult = parsePositiveInteger(
        req.query.limit,
        25,
        100
      );

      if (
        !pageResult.valid ||
        !limitResult.valid
      ) {
        return res.status(400).json({
          message:
            "Page must be a positive integer and limit must be between 1 and 100.",
        });
      }

      const search = String(
        req.query.search || ""
      )
        .trim()
        .slice(0, 100);

      const query = {};

      if (search) {
        const searchRegex = {
          $regex: escapeRegex(search),
          $options: "i",
        };

        query.$or = [
          { name: searchRegex },
          { contactPerson: searchRegex },
          { phone: searchRegex },
          { gstNumber: searchRegex },
        ];
      }

      const page = pageResult.value;
      const limit = limitResult.value;
      const skip = (page - 1) * limit;

      const [items, totalItems] =
        await Promise.all([
          Supplier.find(query)
            .select(
              "name contactPerson phone gstNumber createdAt updatedAt"
            )
            .sort({ name: 1, _id: 1 })
            .skip(skip)
            .limit(limit)
            .lean(),
          Supplier.countDocuments(query),
        ]);

      return res.json({
        items,
        pagination: {
          page,
          limit,
          totalItems,
          totalPages: Math.ceil(
            totalItems / limit
          ),
        },
      });
    } catch (err) {
      console.error(
        "GET SUPPLIERS ERROR:",
        err
      );

      return res.status(500).json({
        message: "Unable to load suppliers.",
      });
    }
  }
);


/* ==========================================================
   GET SUPPLIER
========================================================== */

router.get(
  "/:id",
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          message: "Invalid supplier ID.",
        });
      }

      const supplier = await Supplier.findById(id)
        .select(
          "name contactPerson phone email address gstNumber notes createdAt updatedAt"
        )
        .lean();

      if (!supplier) {
        return res.status(404).json({
          message: "Supplier not found.",
        });
      }

      return res.json(supplier);
    } catch (err) {
      console.error(
        "GET SUPPLIER ERROR:",
        err
      );

      return res.status(500).json({
        message: "Unable to load supplier.",
      });
    }
  }
);


/* ==========================================================
   CREATE SUPPLIER
========================================================== */

router.post(
  "/",
  async (req, res) => {
    const payloadResult = getSupplierPayload(req.body || {});

    if (!payloadResult.valid) {
      return res.status(400).json({
        message: payloadResult.message,
      });
    }

    try {
      const supplier = await Supplier.create(
        payloadResult.value
      );

      return res.status(201).json({
        message: "Supplier created successfully.",
        supplier,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return res.status(409).json({
          message:
            "A supplier with this name already exists.",
        });
      }

      if (err.name === "ValidationError") {
        return res.status(400).json({
          message: err.message,
        });
      }

      console.error(
        "CREATE SUPPLIER ERROR:",
        err
      );

      return res.status(500).json({
        message: "Unable to create supplier.",
      });
    }
  }
);


/* ==========================================================
   UPDATE SUPPLIER MASTER DATA
========================================================== */

router.put(
  "/:id",
  async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid supplier ID.",
      });
    }

    const payloadResult = getSupplierPayload(req.body || {});

    if (!payloadResult.valid) {
      return res.status(400).json({
        message: payloadResult.message,
      });
    }

    try {
      const supplier = await Supplier.findById(id);

      if (!supplier) {
        return res.status(404).json({
          message: "Supplier not found.",
        });
      }

      Object.assign(
        supplier,
        payloadResult.value
      );

      await supplier.save();

      return res.json({
        message: "Supplier updated successfully.",
        supplier,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return res.status(409).json({
          message:
            "A supplier with this name already exists.",
        });
      }

      if (err.name === "ValidationError") {
        return res.status(400).json({
          message: err.message,
        });
      }

      console.error(
        "UPDATE SUPPLIER ERROR:",
        err
      );

      return res.status(500).json({
        message: "Unable to update supplier.",
      });
    }
  }
);


module.exports = router;
