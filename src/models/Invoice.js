const mongoose = require("mongoose");
const { GST_RATE_PERCENTS } = require("../utils/gst");

/*
 * GST Tax Invoice. Prices are exclusive of GST. Every line snapshots its
 * price, HSN and GST rate; the seller and customer details and the tax type
 * are snapshotted too, so later master-data changes never alter an invoice.
 * Tax math lives only in utils/gstInvoice.js.
 */

const paise = (message, { min = 0 } = {}) => ({
  type: Number,
  required: true,
  min,
  validate: { validator: Number.isSafeInteger, message },
});

const lineSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", required: true },
    productName: { type: String, required: true, trim: true, maxlength: 150 },
    unit: { type: String, required: true, enum: ["pcs", "dozen"] },
    hsnCode: { type: String, required: true, match: /^\d{4,8}$/ },
    gstRatePercent: { type: Number, required: true, enum: GST_RATE_PERCENTS },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 100000,
      validate: { validator: Number.isSafeInteger, message: "Quantity must be a whole number." },
    },
    pricePaise: paise("Price must be whole paise.", { min: 1 }),
    taxablePaise: paise("Taxable value must be whole paise.", { min: 1 }),
    batchReference: { type: String, default: "", trim: true, maxlength: 100 },
    // Quantity already covered by ACTIVE delivery challans (Step 11E). Kept in
    // step with challans inside the same transaction, under the invoice lock.
    dispatchedQuantity: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const taxRowSchema = new mongoose.Schema(
  {
    gstRatePercent: { type: Number, required: true, enum: GST_RATE_PERCENTS },
    taxablePaise: paise("Taxable value must be whole paise."),
    cgstPaise: paise("CGST must be whole paise."),
    sgstPaise: paise("SGST must be whole paise."),
    igstPaise: paise("IGST must be whole paise."),
    taxPaise: paise("Tax must be whole paise."),
  },
  { _id: false }
);

const address = {
  line1: { type: String, default: "" },
  line2: { type: String, default: "" },
  city: { type: String, default: "" },
  pincode: { type: String, default: "" },
};

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, trim: true },
    financialYear: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    sequence: { type: Number, required: true, min: 1 },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customerSnapshot: {
      name: { type: String, required: true },
      billingName: { type: String, default: "" },
      gstin: { type: String, default: "" },
      stateCode: { type: String, required: true },
      contactNumber: { type: String, default: "" },
      billingAddress: address,
      shippingSameAsBilling: { type: Boolean, default: true },
      shippingAddress: { ...address, stateCode: { type: String, default: "" } },
    },

    seller: {
      legalName: { type: String, required: true },
      tradeName: { type: String, default: "" },
      addressLine1: { type: String, default: "" },
      addressLine2: { type: String, default: "" },
      city: { type: String, default: "" },
      pincode: { type: String, default: "" },
      stateCode: { type: String, required: true },
      stateName: { type: String, default: "" },
      gstin: { type: String, required: true },
      pan: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      declaration: { type: String, default: "" },
      signatoryLabel: { type: String, default: "Authorised Signatory" },
      bank: {
        type: {
          accountName: String,
          accountNumber: String,
          ifsc: String,
          bankName: String,
          branch: String,
        },
        default: null,
      },
    },

    invoiceDate: { type: Date, required: true },
    taxType: { type: String, required: true, enum: ["intra", "inter"] },
    placeOfSupplyStateCode: { type: String, required: true },

    lines: {
      type: [lineSchema],
      validate: {
        validator: (lines) => Array.isArray(lines) && lines.length >= 1 && lines.length <= 100,
        message: "An invoice needs 1 to 100 lines.",
      },
    },
    taxSummary: { type: [taxRowSchema], default: [] },

    taxablePaise: paise("Taxable value must be whole paise.", { min: 1 }),
    cgstPaise: paise("CGST must be whole paise."),
    sgstPaise: paise("SGST must be whole paise."),
    igstPaise: paise("IGST must be whole paise."),
    taxTotalPaise: paise("Tax must be whole paise."),
    roundOffPaise: {
      type: Number,
      required: true,
      min: -49,
      max: 50,
      validate: { validator: Number.isSafeInteger, message: "Round off must be whole paise." },
    },
    totalPaise: paise("Total must be whole paise.", { min: 1 }),
    totalInWords: { type: String, default: "" },

    status: { type: String, required: true, enum: ["active", "reversed"], default: "active" },
    notes: { type: String, default: "", trim: true, maxlength: 500 },

    // Bumped by every edit, reversal, payment and void: serializes concurrent writes.
    revision: { type: Number, default: 0, min: 0 },

    createdBy: { type: String, default: "Admin" },
    updatedBy: { type: String, default: "Admin" },

    reversedAt: { type: Date, default: null },
    reversedBy: { type: String, default: "" },
    reverseReason: { type: String, default: "", trim: true, maxlength: 250 },

    // Dispatch counters (Step 11E). Challans are the auditable record; these
    // make dispatch progress and the reverse/edit guards free of extra queries.
    activeChallanCount: { type: Number, default: 0, min: 0 },
    dispatchStatus: { type: String, enum: ["none", "partial", "full"], default: "none" },

    // Reserved for Step 11D (estimate conversion without a second stock deduction).
    sourceEstimate: { type: mongoose.Schema.Types.ObjectId, ref: "Estimate", default: null },
    sourceEstimateNumber: { type: String, default: "" },
  },
  { timestamps: true }
);

invoiceSchema.index({ invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ customer: 1, invoiceDate: -1, _id: -1 });
invoiceSchema.index({ status: 1, invoiceDate: -1, _id: -1 });
invoiceSchema.index({ invoiceDate: -1, _id: -1 });
// One estimate can become at most one invoice (11D).
invoiceSchema.index(
  { sourceEstimate: 1 },
  { unique: true, partialFilterExpression: { sourceEstimate: { $type: "objectId" } } }
);

module.exports = mongoose.model("Invoice", invoiceSchema);
