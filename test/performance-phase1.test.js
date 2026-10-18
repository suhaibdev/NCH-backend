const assert = require("assert");
const { EventEmitter } = require("events");
const createDatabaseReadinessMiddleware = require("../src/middleware/databaseReadiness");
const { buildDashboardResponse } = require("../src/utils/dashboardResponse");
const { createRequestTiming, getHealthResponse } = require("../src/utils/operationalStatus");

assert.deepStrictEqual(getHealthResponse(true), {
  statusCode: 200,
  body: {
    status: "ready",
    database: "connected",
  },
});

assert.deepStrictEqual(getHealthResponse(false), {
  statusCode: 503,
  body: {
    status: "not_ready",
    database: "disconnected",
  },
});

const unavailableResponse = {
  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
};
let blockedNextCalled = false;

createDatabaseReadinessMiddleware(() => false)({}, unavailableResponse, () => {
  blockedNextCalled = true;
});

assert.strictEqual(blockedNextCalled, false);
assert.strictEqual(unavailableResponse.statusCode, 503);
assert.deepStrictEqual(unavailableResponse.body, {
  status: "not_ready",
  database: "disconnected",
});

let readyNextCalled = false;

createDatabaseReadinessMiddleware(() => true)({}, {}, () => {
  readyNextCalled = true;
});

assert.strictEqual(readyNextCalled, true);

const dashboard = buildDashboardResponse({
  totalEmployees: 12,
  activeEmployees: 10,
  totalCustomers: 8,
  presentToday: 7,
  attendanceMarked: 9,
  monthSalary: [{ total: 1200 }],
  monthAdvance: [{ total: 400 }],
  recentEmployees: [{ name: "Amina", baseDailySalary: 500 }],
});

assert.deepStrictEqual(dashboard, {
  totalEmployees: 12,
  activeEmployees: 10,
  totalCustomers: 8,
  attendanceToday: 7,
  absentToday: 3,
  attendanceMarked: 9,
  monthSalary: 1200,
  monthAdvance: 400,
  recentEmployees: [{ name: "Amina", baseDailySalary: 500 }],
});
assert.strictEqual(Object.hasOwn(dashboard, "advanceSummary"), false);
assert.strictEqual(Object.hasOwn(dashboard, "salaryCycle"), false);

const response = new EventEmitter();
response.statusCode = 401;
const timingLogs = [];
let timingNextCalled = false;

createRequestTiming("POST /api/auth/login", (message) => timingLogs.push(message))(
  {},
  response,
  () => {
    timingNextCalled = true;
  }
);
response.emit("finish");

assert.strictEqual(timingNextCalled, true);
assert.strictEqual(response.statusCode, 401);
assert.match(timingLogs[0], /^POST \/api\/auth\/login failed in \d+ms status=401$/);
assert.strictEqual(/password|token|secret|email/i.test(timingLogs[0]), false);

console.log("Phase 1 performance helpers: 10 checks passed.");
