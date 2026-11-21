// File: server/models/Customer.js
const mongoose = require('mongoose');
const { GSTIN_PATTERN, isValidStateCode } = require('../utils/gst');

const optionalStateCode = {
  validator: (value) => !value || isValidStateCode(value),
  message: 'State must be a valid GST state code.',
};

const optionalPincode = {
  validator: (value) => !value || /^\d{6}$/.test(value),
  message: 'PIN code must be exactly 6 digits.',
};

const addressFields = () => ({
  line1: { type: String, default: '', trim: true, maxlength: 200 },
  line2: { type: String, default: '', trim: true, maxlength: 200 },
  city: { type: String, default: '', trim: true, maxlength: 80 },
  pincode: { type: String, default: '', trim: true, validate: optionalPincode },
});

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    // Stored as text so leading zeros survive; legacy numeric values are cast on load.
    contactNumber: {
      type: String,
      default: '',
      validate: {
        validator: (value) => !value || /^\d{10}$/.test(value),
        message: 'Contact number must be exactly 10 digits.',
      },
    },
    // GSTIN (field name kept for backward compatibility).
    gst: {
      type: String,
      default: '',
      uppercase: true,
      validate: {
        validator: (value) => !value || GSTIN_PATTERN.test(value),
        message: 'GSTIN must be a valid 15-character GST number.',
      },
    },
    billingName: { type: String, default: '', trim: true, maxlength: 150 },
    contactPerson: { type: String, default: '', trim: true, maxlength: 100 },
    // Derived from the GSTIN, or chosen manually when there is no GSTIN.
    stateCode: { type: String, default: '', validate: optionalStateCode },
    billingAddress: addressFields(),
    shippingSameAsBilling: { type: Boolean, default: true },
    shippingAddress: {
      ...addressFields(),
      stateCode: { type: String, default: '', validate: optionalStateCode },
    },
    isActive: { type: Boolean, default: true },

    // Legacy fields (no caller); kept untouched until a planned cleanup.
    stock: { type: Number, default: 0 },
    orders: [
      {
        product: String,
        quantity: Number,
        date: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

customerSchema.index({ gst: 1 });
customerSchema.index({ isActive: 1, name: 1 });

module.exports = mongoose.model('Customer', customerSchema);
