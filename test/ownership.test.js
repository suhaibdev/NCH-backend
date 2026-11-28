/*
 * Ownership helper for the future customer and supplier portals. Pure.
 */
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { getOwnerScope, isOwnedRecord, scopeFilter } = require("../src/utils/ownership");

const A = "64b00000000000000000000a";
const B = "64b00000000000000000000b";
const objectId = (value) => new mongoose.Types.ObjectId(value);

const customer = { id: "u1", role: "customer", customerId: A };
const supplier = { id: "u2", role: "supplier", supplierId: A };

assert.deepEqual(getOwnerScope(customer), { field: "customer", id: A });
assert.deepEqual(getOwnerScope(supplier), { field: "supplier", id: A });
assert.deepEqual(getOwnerScope({ role: "customer", customerId: objectId(A) }), {
  field: "customer",
  id: A,
});

// Own records, as a string id, an ObjectId or a populated document.
for (const owner of [A, A.toUpperCase(), objectId(A), { _id: objectId(A), name: "Mine" }]) {
  assert.equal(isOwnedRecord(customer, { customer: owner }), true);
  assert.equal(isOwnedRecord(supplier, { supplier: owner }), true);
}

// Another party's records.
for (const owner of [B, objectId(B), { _id: objectId(B) }]) {
  assert.equal(isOwnedRecord(customer, { customer: owner }), false);
  assert.equal(isOwnedRecord(supplier, { supplier: owner }), false);
}

// A real model document works too.
const Invoice = require("../src/models/Invoice");
assert.equal(isOwnedRecord(customer, new Invoice({ customer: A })), true);
assert.equal(isOwnedRecord(customer, new Invoice({ customer: B })), false);

// The same id does not cross between customers and suppliers.
assert.equal(isOwnedRecord(supplier, { customer: A }), false);
assert.equal(isOwnedRecord(customer, { supplier: A }), false);

// Missing or malformed owners.
for (const record of [
  null,
  undefined,
  {},
  { customer: null },
  { customer: "" },
  { customer: {} },
  { customer: "not-an-id" },
  { customer: [A] },
]) {
  assert.equal(isOwnedRecord(customer, record), false, JSON.stringify(record));
}

// Users without a scope are denied everything, including an admin.
const noScope = [
  null,
  undefined,
  {},
  { role: "admin", customerId: A, supplierId: A },
  { role: "employee", customerId: A },
  { role: "factory_manager", customerId: A },
  { role: "customer" },
  { role: "customer", customerId: "" },
  { role: "customer", customerId: "bad" },
  { role: "customer", customerId: "123456789012" },
  { role: "customer", customerId: { $ne: null } },
  { role: "customer", customerId: [A] },
  { role: "customer", supplierId: A },
  { role: "supplier", customerId: A },
  { role: "toString", customerId: A },
  { role: "__proto__", customerId: A },
];
for (const user of noScope) {
  assert.equal(getOwnerScope(user), null, JSON.stringify(user));
  assert.equal(isOwnedRecord(user, { customer: A, supplier: A }), false);
  assert.throws(() => scopeFilter(user, "customer"), /No ownership scope/);
  assert.throws(() => scopeFilter(user, "supplier"), /No ownership scope/);
}

// Queries always carry the owner condition and cannot be widened by the caller.
assert.deepEqual(scopeFilter(customer, "customer"), { $and: [{}, { customer: A }] });
assert.deepEqual(scopeFilter(customer, "customer", { _id: B }), {
  $and: [{ _id: B }, { customer: A }],
});
assert.deepEqual(scopeFilter(customer, "customer", { customer: B }), {
  $and: [{ customer: B }, { customer: A }],
});
assert.deepEqual(scopeFilter(supplier, "supplier", { $or: [{ supplier: B }, {}] }), {
  $and: [{ $or: [{ supplier: B }, {}] }, { supplier: A }],
});

// A user of one kind cannot use a route of the other kind.
assert.throws(() => scopeFilter(supplier, "customer"), /No ownership scope/);
assert.throws(() => scopeFilter(customer, "supplier"), /No ownership scope/);
assert.throws(() => scopeFilter(customer), /No ownership scope/);

console.log("Ownership: all assertions passed.");
