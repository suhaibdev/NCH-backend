/*
 * The protected password check used by every login type: lockout, password
 * comparison that does not reveal whether the account exists, and audit.
 * A new login route supplies its loginType and how to find its user.
 */
const bcrypt = require("bcrypt");
const { recordAudit } = require("./auditLog");
const { buildLockoutKeys, normalizeIdentifier } = require("./loginLockout");

/*
 * A bcrypt hash of a discarded random value, with the same cost (12) as real
 * password hashes. It is compared when no user is found, so an unknown account
 * takes as long to refuse as a wrong password.
 */
const DUMMY_PASSWORD_HASH = "$2b$12$D2DNiCaRVcg.m446P6OqIe3Bd6.J1lLplox/5TR30MUFSpcipCC1i";

/** Resolves to { status: "ok", user } | { status: "invalid" } | { status: "locked" }. */
const runGuardedLogin = async ({ lockout, loginType, identifier, password, req, findUser }) => {
  const account = normalizeIdentifier(identifier);
  const keys = buildLockoutKeys(loginType, account, req.ip);
  const audit = (action, extra = {}) =>
    recordAudit({
      req,
      actor: null,
      role: "",
      identifier: account,
      action,
      recordType: "auth",
      ...extra,
    });

  return lockout.runExclusive(keys, async () => {
    const state = await lockout.check(keys);
    if (state.locked) {
      await audit("login.lockout", { details: { loginType, scopes: state.scopes } });
      return { status: "locked" };
    }

    const user = await findUser();
    const passwordMatches = await bcrypt.compare(
      password,
      user ? user.password : DUMMY_PASSWORD_HASH
    );

    if (!user || !passwordMatches) {
      const { startedLocks } = await lockout.recordFailure(keys);
      await audit("login.failure", { details: { loginType } });
      if (startedLocks.length) {
        await audit("login.lockout", { details: { loginType, scopes: startedLocks } });
      }
      return { status: "invalid" };
    }

    await lockout.recordSuccess(keys);
    await audit("login.success", {
      actor: user._id.toString(),
      role: user.role,
      recordId: user._id.toString(),
      details: { loginType },
    });
    return { status: "ok", user };
  });
};

module.exports = { DUMMY_PASSWORD_HASH, runGuardedLogin };
