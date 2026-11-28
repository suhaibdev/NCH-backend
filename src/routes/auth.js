const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const LoginAttempt = require("../models/LoginAttempt");
const { runGuardedLogin } = require("../utils/guardedLogin");
const { LOCKED_MESSAGE, createLoginLockout } = require("../utils/loginLockout");

const router = express.Router();
const lockout = createLoginLockout({ Model: LoginAttempt });

// This route serves the admin login. Later login types pass their own value.
const LOGIN_TYPE = "admin";

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Non-text values are refused here, the same way for any account.
    if (!email || !password || typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is not configured.");
      return res.status(500).json({ success: false, message: "Authentication is not configured." });
    }

    const outcome = await runGuardedLogin({
      lockout,
      loginType: LOGIN_TYPE,
      identifier: email,
      password,
      req,
      findUser: () => User.findOne({ email: email.trim().toLowerCase() }),
    });
    if (outcome.status === "locked") {
      return res.status(429).json({ success: false, message: LOCKED_MESSAGE });
    }
    if (outcome.status !== "ok") {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    const { user } = outcome;
    const token = jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to log in. Please try again." });
  }
});

module.exports = router;
