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
  // `SELECT 1` to touch Postgres - but fire-and-forget, never awaited. If we
  // awaited it and Supabase were slow/paused, the request would stall until
  // Render returned a multi-KB HTML 502/504 page, which the uptime monitor
  // (cron-job.org) rejects as "output too large". Responding immediately with
  // a tiny plain-text body keeps the response well under that limit no matter
  // what the database is doing.
  //
  // The flip side: this endpoint reports OK through a total database outage, so
  // it is a liveness check for the web process ONLY. /api/health/db below is the
  // one that actually tells you whether Postgres is answering.
  prisma.$queryRaw`SELECT 1`.catch((err) =>
    logger.error("health check DB keep-alive query failed", err)
  );
  res.type("text/plain").send("OK");
});

/** Give up on the probe well before Render's own 30s gateway timeout. */
const DB_PROBE_TIMEOUT_MS = 8000;

/**
 * Real database probe, kept OFF the keep-alive path.
 *
 * Point a second uptime monitor here to be alerted on database trouble rather
 * than only on the web process dying. Unlike /api/health this awaits the query
 * and reports what it found, including how long Supabase took - a round-trip
 * that creeps up is the early warning for the pool exhaustion that shows up in
 * the UI as pages hanging on load.
 *
 * Bounded by its own timeout so a wedged connection can't hold the request open
 * until the gateway kills it, and every branch returns a tiny JSON body - a slow
 * database must never become a multi-KB Render error page.
 */
app.get("/api/health/db", async (_req, res) => {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no response in ${DB_PROBE_TIMEOUT_MS}ms`)),
          DB_PROBE_TIMEOUT_MS
        );
      }),
    ]);
    res.json({ db: "ok", ms: Date.now() - started });
  } catch (err) {
    // Caught here rather than left to the error handler: Express 4 does not
    // forward async rejections, and a 503 with a short reason is far more useful
    // to a monitor than a generic 500.
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[health] database probe failed", err);
    res.status(503).json({ db: "down", ms: Date.now() - started, error: message.slice(0, 200) });
  } finally {
    clearTimeout(timer);
  }
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

  // Daily sweep that posts recurring subscription fees as they fall due.
  import("./jobs/subscriptionExpenseJobs.js")
    .then(({ registerSubscriptionCron }) => registerSubscriptionCron())
    .catch((err) => logger.error("[subscription-cron] failed to register:", err));
});






