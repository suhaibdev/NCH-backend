const createDatabaseReadinessMiddleware = (isDatabaseReady) => (req, res, next) => {
  if (isDatabaseReady()) {
    return next();
  }

  return res.status(503).json({
    status: "not_ready",
    database: "disconnected",
  });
};

module.exports = createDatabaseReadinessMiddleware;
