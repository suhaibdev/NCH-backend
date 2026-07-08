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

// A simple test route
app.get('/', (req, res) => {
  res.send('Backend server is running!');
});

// Register API routes
app.use('/api/employees', employeeRoutes);
app.use('/api/customers', customerRoutes);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
  app.listen(port, () => {
    console.log(`Server is running on port: ${port}`);
  });
}).catch((err) => {
  console.error('Failed to connect to MongoDB', err);
  process.exit(1);
});
