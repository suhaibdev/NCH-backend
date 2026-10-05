const mongoose = require("mongoose");

const supplierSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

    normalizedName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 150,
    },

    contactPerson: {
      type: String,
      default: "",
      trim: true,
      maxlength: 100,
    },

    phone: {
      type: String,
      default: "",
      maxlength: 10,
      validate: {
        validator: (value) =>
          !value || /^\d{10}$/.test(value),
        message:
          "Contact number must be exactly 10 digits.",
      },
    },

    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      maxlength: 160,
    },

    address: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    gstNumber: {
      type: String,
      default: "",
      uppercase: true,
      maxlength: 15,
      validate: {
        validator: (value) =>
          !value ||
          /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(
            value
          ),
        message:
          "GSTIN must be a valid 15-character GST number.",
      },
    },

    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },
  },
  {
    timestamps: true,
  }
);


supplierSchema.pre(
  "validate",
  function (next) {
    if (this.name) {
      this.name = String(this.name)
        .trim()
        .replace(/\s+/g, " ");

      this.normalizedName =
        this.name.toLowerCase();
    }

    if (this.email) {
      this.email = String(this.email)
        .trim()
        .toLowerCase();
    }

    next();
  }
);


supplierSchema.index(
  { normalizedName: 1 },
  { unique: true }
);

supplierSchema.index({ name: 1, _id: 1 });
supplierSchema.index({ phone: 1 });
supplierSchema.index({ gstNumber: 1 });


module.exports = mongoose.model(
  "Supplier",
  supplierSchema
);
