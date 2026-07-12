import { logger } from './lib/logger.js';
import "dotenv/config";
import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import apiRoutes from "./routes/index.js";
import { errorHandler } from "./middleware/error.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { assertJwtSecret } from "./lib/jwt.js";

// Fail fast if the JWT secret isn't configured, rather than booting an insecure
// server that only errors on the first login.
assertJwtSecret();

const app = express();

// Trust the reverse proxy (needed for correct client IPs behind nginx/render,
// which the rate limiter keys on).
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173" }));
app.use(express.json());

// Serve uploaded invoice files. These are opened as plain browser links (which
// can't carry the Bearer token), so access is gated by unguessable filenames
// (see lib/upload.ts) rather than middleware — a capability-URL scheme. Set
// noindex/nosniff so the PII files aren't crawled or content-sniffed.
app.use(
  "/uploads",
  (_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  },
  express.static(path.resolve(process.cwd(), "uploads")),
);

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "rvp-server",
    time: new Date().toISOString(),
  });
});

app.use("/api", apiLimiter, apiRoutes);

// Error handler must be registered last.
app.use(errorHandler);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, "0.0.0.0", () => {
  logger.info(`rvp-server listening on http://localhost:${port}`);

  // Bootstrap missing accounts. (40040 Internal Weight Profit was decommissioned.)
  import("./lib/prisma.js").then(async ({ prisma }) => {
    try {
      await prisma.account.upsert({
        where: { code: '50080' },
        update: { name: 'Interest Expense', type: 'EXPENSE' },
        create: { code: '50080', name: 'Interest Expense', type: 'EXPENSE' },
      });
      await prisma.account.upsert({
        where: { code: '50090' },
        update: { name: 'Transport Expense (Internal)', type: 'EXPENSE' },
        create: { code: '50090', name: 'Transport Expense (Internal)', type: 'EXPENSE' },
      });
    } catch(e) {
      logger.error(e);
    }
  });

  // Optionally start the Slack bot (Socket Mode) in the same process. A failure
  // here must never take down the API server, so it's isolated in try/catch.
  if (process.env.SLACK_ENABLED === "true") {
    import("./slack/app.js")
      .then(({ startSlackBot }) => startSlackBot())
      .catch((err) => logger.error("[slack] failed to start:", err));
  }
});






