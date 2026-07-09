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

// A simple test route
app.get('/', (req, res) => {
  res.send('Backend server is running!');
});

// Register API routes
app.use('/api/employees', employeeRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/payout', payoutRoutes);

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
