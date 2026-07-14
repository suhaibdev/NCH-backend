const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./src/models/User');

dotenv.config();

const admin = {
  name: 'Admin',
  email: 'admin@nch.com',
  password: 'Admin@123',
  role: 'admin',
};

async function createAdmin() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured.');
  }

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
  console.log('IMPORTANT: Change the default password after the first login.');
}

createAdmin()
  .catch((error) => {
    console.error('Unable to create admin:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
