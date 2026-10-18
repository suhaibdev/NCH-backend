const elapsedMilliseconds = (startedAt) =>
  Math.max(0, Number((process.hrtime.bigint() - startedAt) / BigInt(1_000_000)));

const getHealthResponse = (isDatabaseReady) => {
  if (isDatabaseReady) {
    return {
      statusCode: 200,
      body: {
        status: "ready",
        database: "connected",
      },
    };
  }

  return {
    statusCode: 503,
    body: {
      status: "not_ready",
      database: "disconnected",
    },
  };
};

const formatOperationTiming = (label, durationMilliseconds) =>
  `${label} in ${Math.max(0, Math.round(durationMilliseconds))}ms`;

const createRequestTiming =
  (label, log = console.log) =>
  (req, res, next) => {
    const startedAt = process.hrtime.bigint();

    res.once("finish", () => {
      const outcome = res.statusCode >= 400 ? "failed" : "completed";
      const durationMilliseconds = elapsedMilliseconds(startedAt);

      log(`${label} ${outcome} in ${durationMilliseconds}ms status=${res.statusCode}`);
    });

    next();
  };

module.exports = {
  createRequestTiming,
  elapsedMilliseconds,
  formatOperationTiming,
  getHealthResponse,
};
