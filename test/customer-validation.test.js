/*
 * Customer payload validation (no DB).
 */
const assert = require("node:assert/strict");
const Customer = require("../src/models/Customer");
const { buildCustomerPayload } = require("../src/utils/customerValidation");

const UP_GSTIN = "09AAACH7409R1ZZ";

const base = {
  name: "  Shree   Medicals ",
  email: " Orders@Shree.IN ",
  contactNumber: "0522123456",
  gst: "",
  stateCode: "09",
};

// Create: cleaned, email lowercased, defaults filled.
let result = buildCustomerPayload(base);
assert.equal(result.valid, true, result.message);
assert.equal(result.value.name, "Shree Medicals");
assert.equal(result.value.email, "orders@shree.in");
assert.equal(result.value.contactNumber, "0522123456");
assert.equal(result.value.stateCode, "09");
assert.equal(result.value.isActive, true);
assert.equal(result.value.shippingSameAsBilling, true);
assert.deepEqual(result.value.shippingAddress, { line1: "", line2: "", city: "", pincode: "", stateCode: "" });

// Required fields
assert.equal(buildCustomerPayload({ ...base, name: " " }).message, "Customer name is required.");
assert.equal(buildCustomerPayload({ ...base, email: "" }).message, "Customer email is required.");
assert.equal(buildCustomerPayload({ ...base, email: "bad@" }).message, "Please enter a valid email address.");
assert.equal(buildCustomerPayload(null).valid, false);

// Phone
assert.equal(buildCustomerPayload({ ...base, contactNumber: "12345" }).valid, false);
assert.equal(buildCustomerPayload({ ...base, contactNumber: "98765abcde" }).valid, false);
assert.equal(buildCustomerPayload({ ...base, contactNumber: 9876543210 }).value.contactNumber, "9876543210");
assert.equal(buildCustomerPayload({ ...base, contactNumber: "" }).value.contactNumber, "");

// GSTIN locks the state
result = buildCustomerPayload({ ...base, gst: UP_GSTIN.toLowerCase(), stateCode: "" });
assert.equal(result.valid, true, result.message);
assert.equal(result.value.gst, UP_GSTIN);
assert.equal(result.value.stateCode, "09");

result = buildCustomerPayload({ ...base, gst: UP_GSTIN, stateCode: "09" });
assert.equal(result.valid, true);

result = buildCustomerPayload({ ...base, gst: UP_GSTIN, stateCode: "27" });
assert.equal(result.valid, false);
assert.equal(result.message, "State must match the first two digits of the GSTIN.");

assert.equal(buildCustomerPayload({ ...base, gst: "09AAACH7409R1Z" }).valid, false, "short GSTIN");
assert.equal(buildCustomerPayload({ ...base, gst: "25AAACH7409R1ZZ" }).valid, false, "retired prefix");

// No GSTIN requires a manual, valid state
assert.equal(
  buildCustomerPayload({ ...base, stateCode: "" }).message,
  "Select the customer's state when there is no GSTIN."
);
assert.equal(buildCustomerPayload({ ...base, stateCode: "25" }).valid, false);
assert.equal(buildCustomerPayload({ ...base, stateCode: "27" }).value.stateCode, "27");

// Billing address
result = buildCustomerPayload({
  ...base,
  billingAddress: { line1: " 12 Aminabad ", line2: "", city: " Lucknow ", pincode: "226018" },
});
assert.deepEqual(result.value.billingAddress, {
  line1: "12 Aminabad",
  line2: "",
  city: "Lucknow",
  pincode: "226018",
});
assert.equal(buildCustomerPayload({ ...base, billingAddress: { pincode: "2260" } }).valid, false);
assert.equal(buildCustomerPayload({ ...base, billingAddress: "text" }).valid, false);

// Shipping: same as billing clears the shipping address
result = buildCustomerPayload({
  ...base,
  shippingSameAsBilling: true,
  shippingAddress: { line1: "Warehouse", stateCode: "27" },
});
assert.equal(result.value.shippingAddress.line1, "");
assert.equal(result.value.shippingAddress.stateCode, "");

// Shipping: separate address needs line1 and state
assert.equal(
  buildCustomerPayload({ ...base, shippingSameAsBilling: false, shippingAddress: { stateCode: "27" } }).message,
  "Shipping address line 1 is required."
);
assert.equal(
  buildCustomerPayload({ ...base, shippingSameAsBilling: false, shippingAddress: { line1: "Godown" } }).message,
  "Select the shipping state."
);
result = buildCustomerPayload({
  ...base,
  shippingSameAsBilling: false,
  shippingAddress: { line1: "Godown 4", city: "Pune", pincode: "411001", stateCode: "27" },
});
assert.equal(result.valid, true, result.message);
assert.equal(result.value.shippingAddress.stateCode, "27");
assert.equal(buildCustomerPayload({ ...base, shippingSameAsBilling: "no" }).valid, false);

// Booleans must be real booleans
assert.equal(buildCustomerPayload({ ...base, isActive: "false" }).valid, false);
assert.equal(buildCustomerPayload({ ...base, isActive: false }).value.isActive, false);

// Text limits
assert.equal(buildCustomerPayload({ ...base, name: "x".repeat(151) }).valid, false);
assert.equal(buildCustomerPayload({ ...base, name: 5 }).valid, false);

/* ---------- updates on a legacy customer ---------- */

const legacy = {
  _id: "abc",
  name: "Old Customer",
  email: "Old@Example.com",
  contactNumber: 9876543210,
  gst: "OLDINVALIDGST15",
  stock: 0,
  orders: [],
};

// A partial update touches only what was sent, and never re-validates the legacy GST.
result = buildCustomerPayload({ isActive: false }, legacy);
assert.equal(result.valid, true, result.message);
assert.deepEqual(Object.keys(result.changes), ["isActive"]);
assert.equal(result.value.contactNumber, "9876543210", "legacy numeric phone normalised");
assert.equal(result.value.email, "Old@Example.com", "untouched email not rewritten");

result = buildCustomerPayload({ billingName: "Old Customer Pvt Ltd" }, legacy);
assert.deepEqual(Object.keys(result.changes), ["billingName"]);

// Touching the GSTIN validates it and derives the state.
assert.equal(buildCustomerPayload({ gst: "OLDINVALIDGST15" }, legacy).valid, false);
result = buildCustomerPayload({ gst: UP_GSTIN }, legacy);
assert.equal(result.valid, true, result.message);
assert.equal(result.changes.stateCode, "09");
assert.equal(result.changes.gst, UP_GSTIN);

// Clearing the GSTIN on a legacy customer requires a manual state.
assert.equal(buildCustomerPayload({ gst: "" }, legacy).valid, false);
assert.equal(buildCustomerPayload({ gst: "", stateCode: "07" }, legacy).changes.stateCode, "07");

// Turning off "same as billing" needs a shipping address.
assert.equal(buildCustomerPayload({ shippingSameAsBilling: false }, legacy).valid, false);

/* ---------- model casting of legacy values ---------- */

const hydrated = Customer.hydrate({ ...legacy, _id: undefined });
assert.equal(hydrated.contactNumber, "9876543210", "numeric phone cast to string on load");
assert.equal(hydrated.isActive, true, "missing isActive reads as active");

const fresh = new Customer(buildCustomerPayload({ ...base, gst: UP_GSTIN }).value);
assert.equal(fresh.validateSync(), undefined);
assert.equal(new Customer({ ...base, stateCode: "25" }).validateSync()?.errors?.stateCode !== undefined, true);

console.log("Customer validation: all assertions passed.");
