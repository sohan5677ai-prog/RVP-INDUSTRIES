import { logger } from './lib/logger.js';
import "dotenv/config";
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

// Comma-separated list so the deployed client (a Vercel domain, plus any
// custom domain later) can be added without a code change.
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    // No Origin header (server-to-server calls, health checks) - allow.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
}));
app.use(express.json({ limit: '2mb' }));

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






