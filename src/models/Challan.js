const mongoose = require("mongoose");

/*
 * Delivery Challan (Step 11E): a manual dispatch record against ONE invoice.
 * No GST, no GSTIN, no prices, no tax amounts anywhere. A challan never
 * touches stock (the invoice already deducted it) and never touches any
 * payment ledger. Dispatched quantity per invoice line across active
 * challans can never exceed the invoice line quantity.
 */

const lineSchema = new mongoose.Schema(
  {
    // The invoice line's _id this quantity is dispatched against.
    invoiceLine: { type: mongoose.Schema.Types.ObjectId, required: true },
    item: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", required: true },
    productName: { type: String, required: true, trim: true, maxlength: 150 },
    unit: { type: String, required: true, enum: ["pcs", "dozen"] },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 100000,
      validate: { validator: Number.isSafeInteger, message: "Quantity must be a whole number." },
    },
  },
  { _id: true }
);

const challanSchema = new mongoose.Schema(
  {
    challanNumber: { type: String, required: true, trim: true },
    financialYear: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    sequence: { type: Number, required: true, min: 1 },

    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    invoiceNumber: { type: String, required: true, trim: true },
    invoiceDate: { type: Date, required: true },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customerSnapshot: {
      name: { type: String, required: true },
      billingName: { type: String, default: "" },
      contactNumber: { type: String, default: "" },
      shipTo: {
        line1: { type: String, default: "" },
        line2: { type: String, default: "" },
        city: { type: String, default: "" },
        pincode: { type: String, default: "" },
        stateCode: { type: String, default: "" },
      },
    },

    // Public seller details only (no GSTIN, PAN or bank), copied from the invoice.
    seller: {
      legalName: { type: String, default: "" },
      tradeName: { type: String, default: "" },
      addressLine1: { type: String, default: "" },
      addressLine2: { type: String, default: "" },
      city: { type: String, default: "" },
      pincode: { type: String, default: "" },
      stateName: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      signatoryLabel: { type: String, default: "Authorised Signatory" },
    },

    challanDate: { type: Date, required: true },

    lines: {
      type: [lineSchema],
      validate: {
        validator: (lines) => Array.isArray(lines) && lines.length >= 1 && lines.length <= 100,
        message: "A challan needs 1 to 100 lines.",
      },
    },

    transport: {
      transporterName: { type: String, default: "", trim: true, maxlength: 100 },
      vehicleNumber: { type: String, default: "", trim: true, uppercase: true, maxlength: 20 },
      lrNumber: { type: String, default: "", trim: true, maxlength: 50 },
      lrDate: { type: Date, default: null },
    },

    notes: { type: String, default: "", trim: true, maxlength: 500 },

    status: { type: String, required: true, enum: ["active", "cancelled"], default: "active" },

    revision: { type: Number, default: 0, min: 0 },
    createdBy: { type: String, default: "Admin" },
    updatedBy: { type: String, default: "Admin" },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancelReason: { type: String, default: "", trim: true, maxlength: 250 },
  },
  { timestamps: true }
);

challanSchema.index({ challanNumber: 1 }, { unique: true });
challanSchema.index({ invoice: 1, challanDate: -1, _id: -1 });
challanSchema.index({ customer: 1, challanDate: -1, _id: -1 });
challanSchema.index({ status: 1, challanDate: -1, _id: -1 });
challanSchema.index({ challanDate: -1, _id: -1 });

module.exports = mongoose.model("Challan", challanSchema);
