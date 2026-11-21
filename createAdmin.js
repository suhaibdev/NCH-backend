const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./src/models/User');

dotenv.config();

// Admin credentials come from the environment (see .env.example).
// They are never hard-coded and the password is never printed.
const REQUIRED_ENV_VARS = ['MONGODB_URI', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];

function getAdminFromEnv() {
  const missing = REQUIRED_ENV_VARS.filter((name) => !String(process.env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in .env (see .env.example) and run the script again.'
    );
  }

  return {
    name: 'Admin',
    // Match the User model and the login route, which store and look up emails trimmed and lowercased.
    email: process.env.ADMIN_EMAIL.trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD,
    role: 'admin',
  };
}

async function createAdmin() {
  const admin = getAdminFromEnv();

  await mongoose.connect(process.env.MONGODB_URI);

  const existingAdmin = await User.findOne({ email: admin.email });
  if (existingAdmin) {
    console.log(`✅ Admin user with email ${admin.email} already exists.`);
    await mongoose.disconnect();
    return;
  }

  const password = await bcrypt.hash(admin.password, 12);
  await User.create({ ...admin, password });
  console.log(`✅ Admin user created for ${admin.email}.`);
  console.log('IMPORTANT: Remove ADMIN_PASSWORD from .env now that the admin account exists.');
}

createAdmin()
  .catch((error) => {
    console.error('Unable to create admin:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
