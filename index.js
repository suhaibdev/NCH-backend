const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Import routes
const employeeRoutes = require('./src/routes/employees');
const customerRoutes = require('./src/routes/customers');
const attendanceRoutes = require('./src/routes/attendance');
const payoutRoutes = require('./src/routes/payout');
const authRoutes = require('./src/routes/auth');
const verifyToken = require('./src/middleware/authMiddleware');
const authorizeRoles = require('./src/middleware/roleMiddleware');

// A simple test route
app.get('/', (req, res) => {
  res.send('Backend server is running!');
});

// Register API routes
app.use('/api/auth', authRoutes);
app.use('/api/employees', verifyToken, authorizeRoles('admin'), employeeRoutes);
app.use('/api/customers', verifyToken, authorizeRoles('admin'), customerRoutes);
app.use('/api/attendance', verifyToken, authorizeRoles('admin'), attendanceRoutes);
app.use('/api/payout', verifyToken, authorizeRoles('admin'), payoutRoutes);

// Connect to MongoDB with better error handling
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('✅ Connected to MongoDB');
}).catch((err) => {
  console.error('❌ MongoDB Connection Error:', err.message);
  console.error('Make sure MONGODB_URI environment variable is set correctly');
});

// Start server regardless of MongoDB connection
app.listen(port, () => {
  console.log(`🚀 Server is running on port: ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
