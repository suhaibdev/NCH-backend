/*
 * Invoice snapshot builders shared by invoice creation and estimate
 * conversion (pure, no DB). The saved invoice never changes when customer
 * master data changes later.
 */
const { formatDocumentNumber } = require("./salesDocuments");
const { amountInWords } = require("./gstInvoice");

const CUSTOMER_FIELDS =
  "name billingName gst stateCode contactNumber billingAddress shippingSameAsBilling shippingAddress isActive";

const formatInvoiceNumber = (financialYear, sequence) =>
  formatDocumentNumber("INV", financialYear, sequence);

/** The stored tax columns of an Invoice, from computeInvoiceTax output. */
const taxFields = (tax) => ({
  taxSummary: tax.taxSummary,
  taxablePaise: tax.taxablePaise,
  cgstPaise: tax.cgstPaise,
  sgstPaise: tax.sgstPaise,
  igstPaise: tax.igstPaise,
  taxTotalPaise: tax.taxTotalPaise,
  roundOffPaise: tax.roundOffPaise,
  totalPaise: tax.totalPaise,
  totalInWords: amountInWords(tax.totalPaise),
});

const addressSnapshot = (value = {}) => ({
  line1: value?.line1 || "",
  line2: value?.line2 || "",
  city: value?.city || "",
  pincode: value?.pincode || "",
});

/** Customer details as stored on an invoice (needs a valid stateCode). */
const buildCustomerSnapshot = (customer) => ({
  name: customer.name,
  billingName: customer.billingName || "",
  gstin: customer.gst || "",
  stateCode: customer.stateCode,
  contactNumber:
    customer.contactNumber === undefined || customer.contactNumber === null
      ? ""
      : String(customer.contactNumber),
  billingAddress: addressSnapshot(customer.billingAddress),
  shippingSameAsBilling: customer.shippingSameAsBilling !== false,
  shippingAddress: {
    ...addressSnapshot(customer.shippingAddress),
    stateCode: customer.shippingAddress?.stateCode || "",
  },
});

module.exports = {
  CUSTOMER_FIELDS,
  addressSnapshot,
  buildCustomerSnapshot,
  formatInvoiceNumber,
  taxFields,
};
