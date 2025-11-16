// src/utils/logger.js
const { createLogger, format, transports } = require("winston");
const path = require("path");
const fs = require("fs");

const logDir = path.join(__dirname, "../../logs");

// Ensure logs directory exists
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logger = createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.printf(({ level, message, timestamp }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: path.join(logDir, "app.log") }),
    new transports.File({
      filename: path.join(logDir, "error.log"),
      level: "error",
    }),
  ],
});

// ✅ Proper CommonJS export
module.exports = logger;
