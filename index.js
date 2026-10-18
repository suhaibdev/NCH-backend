const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");
const createDatabaseReadinessMiddleware = require("./src/middleware/databaseReadiness");
const {
  createRequestTiming,
  elapsedMilliseconds,
  formatOperationTiming,
  getHealthResponse,
} = require("./src/utils/operationalStatus");

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const startupStartedAt = process.hrtime.bigint();
const isDatabaseReady = () => mongoose.connection.readyState === 1;

// Middleware
app.use(cors());
app.use(express.json());

// Import routes
const employeeRoutes = require("./src/routes/employees");
const customerRoutes = require("./src/routes/customers");
const supplierRoutes = require("./src/routes/suppliers");
const materialReceiptRoutes = require("./src/routes/materialReceipts");
const supplierPaymentRoutes = require("./src/routes/supplierPayments");
const washerRoutes = require("./src/routes/washers");
const washingProcessRoutes = require("./src/routes/washingProcesses");
const manufacturingRoutes = require("./src/routes/manufacturing");
const washerAccountingRoutes = require("./src/routes/washerAccounting");
const attendanceRoutes = require("./src/routes/attendance");
const payoutRoutes = require("./src/routes/payout");
const stockRoutes = require("./src/routes/stock");
const dashboardRoutes = require("./src/routes/dashboard");
const authRoutes = require("./src/routes/auth");
const verifyToken = require("./src/middleware/authMiddleware");
const authorizeRoles = require("./src/middleware/roleMiddleware");

// A simple test route
app.get("/", (req, res) => {
  res.send("Backend server is running!");
});

app.get("/api/health", (req, res) => {
  const health = getHealthResponse(isDatabaseReady());
  return res.status(health.statusCode).json(health.body);
});

app.post("/api/auth/login", createRequestTiming("POST /api/auth/login"));
app.get("/api/dashboard", createRequestTiming("GET /api/dashboard"));
app.use("/api", createDatabaseReadinessMiddleware(isDatabaseReady));

// Register API routes
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", verifyToken, authorizeRoles("admin"), dashboardRoutes);
app.use("/api/employees", verifyToken, authorizeRoles("admin"), employeeRoutes);
app.use("/api/customers", verifyToken, authorizeRoles("admin"), customerRoutes);
app.use("/api/suppliers", verifyToken, authorizeRoles("admin"), supplierRoutes);
app.use("/api/material-receipts", verifyToken, authorizeRoles("admin"), materialReceiptRoutes);
app.use("/api/supplier-payments", verifyToken, authorizeRoles("admin"), supplierPaymentRoutes);
app.use("/api/washers", verifyToken, authorizeRoles("admin"), washerRoutes);
app.use("/api/washing-processes", verifyToken, authorizeRoles("admin"), washingProcessRoutes);
app.use("/api/manufacturing", verifyToken, authorizeRoles("admin"), manufacturingRoutes);
app.use("/api/washer-accounting", verifyToken, authorizeRoles("admin"), washerAccountingRoutes);
app.use("/api/attendance", verifyToken, authorizeRoles("admin"), attendanceRoutes);
app.use("/api/payout", verifyToken, authorizeRoles("admin"), payoutRoutes);
app.use("/api/stock", verifyToken, authorizeRoles("admin"), stockRoutes);

mongoose.connection.on("disconnected", () => {
  console.error("MongoDB disconnected; API readiness is unavailable.");
});

mongoose.connection.on("error", () => {
  console.error("MongoDB connection error; API readiness may be unavailable.");
});

const listen = () =>
  new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.once("error", reject);
  });

const startServer = async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not configured; application server did not start.");
    return null;
  }

  const databaseStartedAt = process.hrtime.bigint();

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
    });

    console.log(formatOperationTiming("MongoDB connected", elapsedMilliseconds(databaseStartedAt)));

    const server = await listen();

    console.log(`Server is running on port: ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(
      formatOperationTiming("Backend startup completed", elapsedMilliseconds(startupStartedAt))
    );

    return server;
  } catch (error) {
    console.error(
      formatOperationTiming(
        "MongoDB connection or server startup failed",
        elapsedMilliseconds(databaseStartedAt)
      )
    );
    console.error(
      "Application server did not start; check database configuration and availability."
    );
    await mongoose.disconnect().catch(() => undefined);
    return null;
  }
};

if (require.main === module) {
  startServer().then((server) => {
    if (!server) {
      process.exitCode = 1;
    }
  });
}

module.exports = {
  app,
  isDatabaseReady,
  startServer,
};
