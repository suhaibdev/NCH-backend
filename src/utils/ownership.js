/*
 * Data ownership for the future customer and supplier portals. Pure, no DB.
 *
 * A customer user may read only records of their own customer; a supplier user
 * only records of their own supplier. For PORTAL ROUTES ONLY: admin routes do
 * not use this, and an admin gets no scope here. Everything unknown is denied.
 *
 * Expects user { role, customerId | supplierId }. User has no such link yet,
 * and verifyToken passes only { id, role }; both come with customer accounts.
 *
 * A portal route should answer 404 (not 403) for a refused record, so nobody
 * can learn that another party's record exists.
 */
const mongoose = require("mongoose");

const OWNER_RULES = {
  customer: { userField: "customerId", recordField: "customer" },
  supplier: { userField: "supplierId", recordField: "supplier" },
};

/** The id as a 24-hex string, or "" when it is not a valid id. */
const toIdString = (value) => {
  if (!value) return "";
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  return typeof value === "string" && /^[a-f0-9]{24}$/i.test(value) ? value.toLowerCase() : "";
};

/** { field, id } for a customer or supplier user, otherwise null. */
const getOwnerScope = (user) => {
  const role = user?.role;
  if (!Object.prototype.hasOwnProperty.call(OWNER_RULES, role)) return null;
  const rule = OWNER_RULES[role];
  const id = toIdString(user[rule.userField]);
  return id ? { field: rule.recordField, id } : null;
};

/*
 * Wraps a query filter so it can only match the user's own records. $and keeps
 * the owner condition even if the caller's filter names the same field.
 * `ownerType` is the kind of owner the route serves ("customer" or "supplier").
 * Throws when the user has no such scope, so a query is never left open.
 */
const scopeFilter = (user, ownerType, filter = {}) => {
  const scope = getOwnerScope(user);
  if (!scope || scope.field !== ownerType) {
    throw new Error("No ownership scope for this user.");
  }
  return { $and: [filter, { [scope.field]: scope.id }] };
};

/** True only when the loaded record belongs to this user. */
const isOwnedRecord = (user, record) => {
  const scope = getOwnerScope(user);
  if (!scope || !record) return false;
  const owner = record[scope.field];
  // The owner may be a raw id or a populated document.
  const ownerId =
    toIdString(owner) || (owner && typeof owner === "object" ? toIdString(owner._id) : "");
  return ownerId !== "" && ownerId === scope.id;
};

module.exports = { getOwnerScope, isOwnedRecord, scopeFilter };
