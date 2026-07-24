import { logger } from './lib/logger.js';
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import apiRoutes from "./routes/index.js";
import { errorHandler } from "./middleware/error.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { assertJwtSecret } from "./lib/jwt.js";
import { prisma } from "./lib/prisma.js";

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
app.use(
  express.json({
    limit: '2mb',
    // Stash the raw request body so the Razorpay webhook can verify its HMAC
    // signature over the exact bytes Razorpay signed (JSON.stringify of the
    // parsed body would not byte-match).
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

app.get("/api/health", (_req, res) => {
  // Keep-alive ping. Render sleeps after 15 min idle AND Supabase free tier
  // pauses a project after 7 days of no DB activity, so we fire a trivial
  // `SELECT 1` to touch Postgres — but fire-and-forget, never awaited. If we
  // awaited it and Supabase were slow/paused, the request would stall until
  // Render returned a multi-KB HTML 502/504 page, which the uptime monitor
  // (cron-job.org) rejects as "output too large". Responding immediately with
  // a tiny plain-text body keeps the response well under that limit no matter
  // what the database is doing.
  prisma.$queryRaw`SELECT 1`.catch((err) =>
    logger.error("health check DB keep-alive query failed", err)
  );
  res.type("text/plain").send("OK");
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

  // Register in-process WhatsApp cron jobs (daily dues/dispatch, weekly summary).
  // No-op unless WHATSAPP_CRON_ENABLED=true; isolated so it can never crash boot.
  import("./jobs/whatsappJobs.js")
    .then(({ registerWhatsappCron }) => registerWhatsappCron())
    .catch((err) => logger.error("[whatsapp-cron] failed to register:", err));
});






