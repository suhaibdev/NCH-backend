/*
 * Customer payload validation (pure, no DB).
 *
 * buildCustomerPayload(body, existing) validates only the fields that were sent,
 * merges them onto the existing customer and checks cross-field rules on the
 * merged result. It returns:
 *   { valid: true, value: <merged customer fields>, changes: <fields to $set> }
 *   { valid: false, message }
 * `changes` holds only touched fields, so a partial update never re-validates
 * an untouched legacy value.
 */
const { isValidGstin, isValidStateCode, stateCodeFromGstin } = require("./gst");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\d{10}$/;
const PINCODE_PATTERN = /^\d{6}$/;

const LIMITS = {
  name: 150,
  billingName: 150,
  email: 160,
  contactPerson: 100,
  line1: 200,
  line2: 200,
  city: 80,
};

const LABELS = {
  name: "Customer name",
  billingName: "Billing name",
  email: "Email",
  contactPerson: "Contact person",
  line1: "Address line 1",
  line2: "Address line 2",
  city: "City",
};

const GSTIN_MESSAGE = "GSTIN must be a valid 15-character GST number.";

const emptyAddress = () => ({ line1: "", line2: "", city: "", pincode: "" });
const emptyShipping = () => ({ ...emptyAddress(), stateCode: "" });

const fail = (message) => ({ valid: false, message });

const cleanText = (value, field, { collapse = false } = {}) => {
  if (value === undefined || value === null) return { valid: true, value: "" };
  if (typeof value !== "string") return fail(`${LABELS[field]} must be text.`);
  let cleaned = value.trim();
  if (collapse) cleaned = cleaned.replace(/\s+/g, " ");
  if (cleaned.length > LIMITS[field]) {
    return fail(`${LABELS[field]} must be ${LIMITS[field]} characters or fewer.`);
  }
  return { valid: true, value: cleaned };
};

const cleanPhone = (value) => {
  if (value === undefined || value === null || value === "") return { valid: true, value: "" };
  if (typeof value !== "string" && typeof value !== "number") {
    return fail("Contact number must be exactly 10 digits.");
  }
  const cleaned = String(value).trim();
  if (cleaned === "") return { valid: true, value: "" };
  if (!PHONE_PATTERN.test(cleaned)) return fail("Contact number must be exactly 10 digits.");
  return { valid: true, value: cleaned };
};

const cleanGstin = (value) => {
  if (value === undefined || value === null) return { valid: true, value: "" };
  if (typeof value !== "string") return fail(GSTIN_MESSAGE);
  const cleaned = value.trim().toUpperCase();
  if (cleaned === "") return { valid: true, value: "" };
  if (!isValidGstin(cleaned)) return fail(GSTIN_MESSAGE);
  return { valid: true, value: cleaned };
};

const cleanStateCode = (value, label = "State") => {
  if (value === undefined || value === null || value === "") return { valid: true, value: "" };
  if (typeof value !== "string" || !isValidStateCode(value.trim())) {
    return fail(`${label} is not a valid GST state code.`);
  }
  return { valid: true, value: value.trim() };
};

const cleanAddress = (value, { withState = false, prefix = "Billing" } = {}) => {
  if (value === undefined || value === null) {
    return { valid: true, value: withState ? emptyShipping() : emptyAddress() };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return fail(`${prefix} address is invalid.`);
  }
  const result = withState ? emptyShipping() : emptyAddress();
  for (const field of ["line1", "line2", "city"]) {
    const cleaned = cleanText(value[field], field, { collapse: field === "city" });
    if (!cleaned.valid) return fail(`${prefix} ${cleaned.message.charAt(0).toLowerCase()}${cleaned.message.slice(1)}`);
    result[field] = cleaned.value;
  }
  const pin = value.pincode;
  if (pin !== undefined && pin !== null && String(pin).trim() !== "") {
    if (
      (typeof pin !== "string" && typeof pin !== "number") ||
      !PINCODE_PATTERN.test(String(pin).trim())
    ) {
      return fail(`${prefix} PIN code must be exactly 6 digits.`);
    }
    result.pincode = String(pin).trim();
  }
  if (withState) {
    const state = cleanStateCode(value.stateCode, `${prefix} state`);
    if (!state.valid) return state;
    result.stateCode = state.value;
  }
  return { valid: true, value: result };
};

const cleanBoolean = (value, label) => {
  if (typeof value !== "boolean") return fail(`${label} must be true or false.`);
  return { valid: true, value };
};

/** Normalizes a stored (possibly legacy) customer into the merged shape. */
const normalizeExisting = (existing) => {
  const source = existing || {};
  const billing = source.billingAddress || {};
  const shipping = source.shippingAddress || {};
  return {
    name: source.name || "",
    billingName: source.billingName || "",
    email: source.email || "",
    contactPerson: source.contactPerson || "",
    contactNumber:
      source.contactNumber === undefined || source.contactNumber === null
        ? ""
        : String(source.contactNumber),
    gst: source.gst || "",
    stateCode: source.stateCode || "",
    billingAddress: {
      line1: billing.line1 || "",
      line2: billing.line2 || "",
      city: billing.city || "",
      pincode: billing.pincode || "",
    },
    shippingSameAsBilling: source.shippingSameAsBilling !== false,
    shippingAddress: {
      line1: shipping.line1 || "",
      line2: shipping.line2 || "",
      city: shipping.city || "",
      pincode: shipping.pincode || "",
      stateCode: shipping.stateCode || "",
    },
    isActive: source.isActive !== false,
  };
};

const buildCustomerPayload = (body, existing = null) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid customer data.");
  }

  const isCreate = !existing;
  const merged = normalizeExisting(existing);
  const touched = new Set();
  const sent = (field) => body[field] !== undefined;

  const apply = (field, result) => {
    if (!result.valid) return result;
    merged[field] = result.value;
    touched.add(field);
    return null;
  };

  const steps = [
    ["name", () => cleanText(body.name, "name", { collapse: true })],
    ["billingName", () => cleanText(body.billingName, "billingName", { collapse: true })],
    ["email", () => {
      const result = cleanText(body.email, "email");
      return result.valid ? { valid: true, value: result.value.toLowerCase() } : result;
    }],
    ["contactPerson", () => cleanText(body.contactPerson, "contactPerson", { collapse: true })],
    ["contactNumber", () => cleanPhone(body.contactNumber)],
    ["gst", () => cleanGstin(body.gst)],
    ["stateCode", () => cleanStateCode(body.stateCode)],
    ["billingAddress", () => cleanAddress(body.billingAddress, { prefix: "Billing" })],
    ["shippingSameAsBilling", () => cleanBoolean(body.shippingSameAsBilling, "Same as billing")],
    ["shippingAddress", () => cleanAddress(body.shippingAddress, { withState: true, prefix: "Shipping" })],
    ["isActive", () => cleanBoolean(body.isActive, "Active")],
  ];

  for (const [field, run] of steps) {
    if (!sent(field)) continue;
    const error = apply(field, run());
    if (error) return error;
  }

  /* ---------- cross-field rules on the merged result ---------- */

  if (!merged.name) return fail("Customer name is required.");
  if (!merged.email) return fail("Customer email is required.");
  if ((isCreate || touched.has("email")) && !EMAIL_PATTERN.test(merged.email)) {
    return fail("Please enter a valid email address.");
  }

  const taxTouched = isCreate || touched.has("gst") || touched.has("stateCode");
  if (taxTouched) {
    if (merged.gst) {
      const gstState = stateCodeFromGstin(merged.gst);
      if (touched.has("stateCode") && merged.stateCode && merged.stateCode !== gstState) {
        return fail("State must match the first two digits of the GSTIN.");
      }
      merged.stateCode = gstState;
    } else if (!merged.stateCode) {
      return fail("Select the customer's state when there is no GSTIN.");
    }
    touched.add("gst");
    touched.add("stateCode");
  }

  const shippingTouched =
    isCreate || touched.has("shippingSameAsBilling") || touched.has("shippingAddress");
  if (shippingTouched) {
    if (merged.shippingSameAsBilling) {
      merged.shippingAddress = emptyShipping();
    } else {
      if (!merged.shippingAddress.line1) return fail("Shipping address line 1 is required.");
      if (!merged.shippingAddress.stateCode) return fail("Select the shipping state.");
    }
    touched.add("shippingSameAsBilling");
    touched.add("shippingAddress");
  }

  if (isCreate) {
    Object.keys(merged).forEach((field) => touched.add(field));
  }

  const changes = {};
  touched.forEach((field) => {
    changes[field] = merged[field];
  });

  return { valid: true, value: merged, changes };
};

module.exports = {
  EMAIL_PATTERN,
  PHONE_PATTERN,
  PINCODE_PATTERN,
  buildCustomerPayload,
  normalizeExisting,
};
