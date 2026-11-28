/*
 * Runs requests through the real Express app without opening a port, reading
 * .env or connecting to MongoDB.
 */
const http = require("http");
const path = require("path");
const { Duplex } = require("stream");

const root = path.join(__dirname, "..", "..");

/** Never read the real .env in tests. */
const stubDotenv = () => {
  const dotenvPath = require.resolve("dotenv");
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: { config: () => ({ parsed: {} }) },
  };
};

/** Loads index.js with the given test-only environment values. */
const loadApp = ({ env = {}, databaseReady = true } = {}) => {
  stubDotenv();
  Object.assign(process.env, env);
  const mongoose = require("mongoose");
  const originalWarn = console.warn;
  const originalLog = console.log;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  const { app } = require(path.join(root, "index.js"));
  console.warn = originalWarn;
  console.log = originalLog;
  // Set after the models are compiled, so Mongoose does not try to open them.
  Object.defineProperty(mongoose.connection, "readyState", {
    configurable: true,
    get: () => (databaseReady ? 1 : 0),
  });
  return { app, warnings };
};

const dispatch = (app, { method = "GET", url, headers = {}, body, ip = "10.0.0.1" }) =>
  new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write: (chunk, encoding, done) => done() });
    socket.remoteAddress = "127.0.0.1";

    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = { "x-forwarded-for": ip };
    Object.entries(headers).forEach(([key, value]) => {
      req.headers[key.toLowerCase()] = value;
    });

    const payload =
      body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    if (payload !== null) {
      req.headers["content-type"] = req.headers["content-type"] || "application/json";
      req.headers["content-length"] = String(Buffer.byteLength(payload));
      req.push(payload);
    }
    req.push(null);

    const res = new http.ServerResponse(req);
    const timer = setTimeout(() => reject(new Error(`No response for ${method} ${url}`)), 5000);
    res.end = (chunk) => {
      clearTimeout(timer);
      const text = chunk ? chunk.toString() : "";
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (error) {
        json = null;
      }
      resolve({ status: res.statusCode, headers: res.getHeaders(), text, body: json });
      res.emit("finish");
      return res;
    };

    app.handle(req, res);
  });

module.exports = { dispatch, loadApp, root, stubDotenv };
