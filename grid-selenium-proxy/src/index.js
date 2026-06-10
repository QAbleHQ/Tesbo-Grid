import { startServer } from "./server.js";
import { logError } from "./logger.js";

process.on("uncaughtException", (err) => {
  logError("uncaught_exception", {
    error: err?.message || String(err),
    stack: err?.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  logError("unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

startServer();
