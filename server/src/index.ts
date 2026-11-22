import { logger } from './lib/logger.js';
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import apiRoutes from "./routes/index.js";
import { errorHandler } from "./middleware/error.js";
import { bulkReadAudit } from './middleware/bulkReadAudit.js';
import { fileUrlRewrite } from './middleware/fileUrlRewrite.js';
import { apiLimiter } from "./middleware/rateLimit.js";
import { assertJwtSecret } from "./lib/jwt.js";
import { isOriginAllowed, originPolicyFromEnv } from "./lib/corsOrigin.js";
import { requireAuthOrCameraBridge } from "./middleware/cameraAuth.js";
import { requireMediaRead, requireMediaWrite } from "./middleware/mediaAuth.js";
import { requireAuth } from "./middleware/auth.js";
import { requestContextMiddleware } from "./lib/requestContext.js";
import { prisma } from "./lib/prisma.js";
import { calcAssociationFee } from "./lib/calc.js";
import { syncTransportRateCards } from "./services/transportRateCard.service.js";

// Fail fast if the JWT secret isn't configured, rather than booting an insecure
// server that only errors on the first login.
assertJwtSecret();

const app = express();

// Trust the reverse proxy (needed for correct client IPs behind nginx/render,
// which the rate limiter keys on).
app.set("trust proxy", 1);

// Whole-origin allow-list. CLIENT_ORIGIN (comma-separated) adds custom domains
// and preview deployments on top of the built-in production origin; localhost
// is accepted only outside production. See lib/corsOrigin.ts for why.
const originPolicy = originPolicyFromEnv();
logger.info(
  `CORS allow-list: ${originPolicy.allowed.join(", ")}${
    originPolicy.allowLocalhost ? " (+ localhost, non-production)" : ""
  }`
);

app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    // No Origin header (server-to-server calls, health checks, curl) - allow.
    // The Tally agent, the CCTV bridge and the Fast2SMS webhooks all arrive
    // this way, and CORS is a browser mechanism: it is not what authenticates
    // them (they carry their own shared secrets).
    if (!origin) return cb(null, true);
    if (isOriginAllowed(origin, originPolicy)) return cb(null, true);
    // Answer without the CORS headers rather than throwing: the browser blocks
    // the read either way, and an Error here would surface as a 500 in the logs
    // for what is really a routine rejection.
    logger.warn(`CORS: rejected origin ${origin}`);
    cb(null, false);
  },
}));
// Body parsing, narrowest first. body-parser marks a request as parsed, so the
// general parser below is a no-op for anything one of these has already taken.
//
// This used to be a single 15 MB parser that stashed `rawBody` on EVERY
// request. Both halves of that cost memory on an instance with 512 MB: the
// ceiling let any endpoint buffer 15 MB, and the `verify` hook kept the raw
// Buffer alive alongside the parsed object for the whole request - so a
// camera frame was held three times over (raw bytes, base64 string, decoded
// JPEG) when only two webhooks ever read the raw form.

/**
 * The webhooks that authenticate by HMAC over the exact bytes they were sent,
 * and so cannot work from a re-serialised body: Razorpay's subscription
 * webhook and Resend's Svix-signed delivery events. Both payloads are small.
 */
const SIGNED_WEBHOOK_PATHS = [
  '/api/subscription/webhook',
  '/api/webhooks/resend',
  // The same handler, reached without the /api prefix via the forwarder below.
  '/webhooks/resend',
];
app.use(
  SIGNED_WEBHOOK_PATHS,
  express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

/**
 * The cabin bridge posts a whole JPEG as a base64 string in a JSON body, which
 * is the only thing here that legitimately needs megabytes.
 */
const CAMERA_FRAME_PATHS = [
  '/api/weighbridge/cctv/broadcast',
  '/api/weighbridge/cctv/detect-plate',
];
app.use(CAMERA_FRAME_PATHS, express.json({ limit: '15mb' }));

/**
 * Everything else. The largest ordinary body is a GPS push, capped at 500
 * records (~100 KB) by the handler itself, so 1 MB is generous.
 */
app.use(express.json({ limit: '1mb' }));

// Establish the per-request context (request id, IP, user agent) that the audit
// trail reads. Before the routes, and before auth, because a failed sign-in has
// to be auditable too - and that is exactly the case with no user to attribute.
app.use(requestContextMiddleware);

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

// The weighbridge media surface. These sit here, ahead of the /api router, so
// that a long-lived MJPEG or SSE connection does not consume the general rate
// limiter's budget - which also put them ahead of requireAuth, leaving every
// one of them open to the internet until Phase 6b.
//
// requireMediaRead accepts a `?k=` capability token as well as a header,
// because <img src> and EventSource cannot send one. requireMediaWrite does
// not: a token that travels in a URL must never be able to change the weight
// the operator sees. See middleware/mediaAuth.ts.
app.get("/api/weighbridge/cctv/snapshot", requireMediaRead, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.snapshotCctvHandler(req, res)).catch(next);
});
app.get("/api/weighbridge/cctv/stream", requireMediaRead, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.streamCctvHandler(req, res)).catch(next);
});
// Verifies the bridge key itself, inside the handler.
app.post("/api/weighbridge/cctv/broadcast", (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.broadcastCctvHandler(req, res)).catch(next);
});
app.get("/api/weighbridge/cctv/status", requireMediaRead, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.getCctvStatusHandler(req, res)).catch(next);
});
// Number-plate recognition runs a billed Gemini call, so it is never anonymous.
// The client reaches it through api() with a Bearer token and the cabin bridge
// has its own key, so requiring one of the two changes nothing for either.
app.post("/api/weighbridge/cctv/detect-plate", requireAuthOrCameraBridge, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.detectPlateCctvHandler(req, res)).catch(next);
});
app.get("/api/weighbridge/snapshots/:filename", requireMediaRead, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.getStoredSnapshotHandler(req, res)).catch(next);
});

// Scale serial live streaming endpoints bypass general API rate limiter.
// /live and /stream are read by the cabin screen (fetch and EventSource);
// /config and /broadcast change what every operator sees, so they are writes.
app.get("/api/weighbridge/scale/live", requireMediaRead, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.getLiveScaleHandler(req, res)).catch(next);
});
app.get("/api/weighbridge/scale/stream", requireMediaRead, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.streamLiveScaleHandler(req, res)).catch(next);
});
app.get("/api/weighbridge/scale/ports", requireMediaWrite, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.listScalePortsHandler(req, res)).catch(next);
});
app.post("/api/weighbridge/scale/config", requireMediaWrite, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.configScalePortHandler(req, res)).catch(next);
});
app.post("/api/weighbridge/scale/broadcast", requireMediaWrite, (req, res, next) => {
  import("./controllers/weighbridge.controller.js").then((m) => m.broadcastScaleReadingHandler(req, res)).catch(next);
});

// Mint a media capability token. Authenticated, and the only way to get one.
app.get("/api/weighbridge/media-token", requireAuth, (req, res, next) => {
  import("./lib/mediaAccessToken.js")
    .then(({ mintMediaAccessToken }) => res.json(mintMediaAccessToken()))
    .catch(next);
});

// Forward root /webhooks/* to apiRoutes so webhook callbacks (e.g. Fast2SMS / Meta / Resend)
// succeed whether configured with or without the /api prefix.
app.use('/webhooks', (req, res, next) => {
  req.url = `/webhooks${req.url}`;
  apiRoutes(req, res, next);
});

// bulkReadAudit before the routes so it wraps res.json for every one of them.
// fileUrlRewrite before the routes so it wraps res.json for all of them: no
// public bucket URL leaves the API, whatever endpoint it came from.
app.use("/api", apiLimiter, bulkReadAudit(), fileUrlRewrite(), apiRoutes);

// Error handler must be registered last.
app.use(errorHandler);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, "0.0.0.0", () => {
  logger.info(`rvp-server listening on http://localhost:${port}`);

  // Bootstrap missing accounts. (40040 Internal Weight Profit was decommissioned.)
  //
  // Via ensureRow, not upsert: an upsert with an empty or unchanged `update`
  // still issues an UPDATE, and this block runs on every boot - which is how
  // 61% of the audit trail came to be these same six rows. See lib/ensureRow.ts.
  Promise.all([import("./lib/prisma.js"), import("./lib/ensureRow.js")]).then(
    async ([{ prisma }, { ensureRow }]) => {
    try {
      await ensureRow(prisma.account as never, {
        where: { code: '50080' },
        keep: { name: 'Interest Expense', type: 'EXPENSE' },
        create: { code: '50080', name: 'Interest Expense', type: 'EXPENSE' },
      });
      await ensureRow(prisma.account as never, {
        where: { code: '50090' },
        keep: { name: 'Transport Expense (Internal)', type: 'EXPENSE' },
        create: { code: '50090', name: 'Transport Expense (Internal)', type: 'EXPENSE' },
      });

      // Bootstrap standard Transports. No `keep`: these are seeded once and
      // then belong to whoever edits them in the app, so boot must not stamp
      // the hardcoded details back over an edit.
      const { row: surya } = await ensureRow(prisma.transport as never, {
        where: { name: 'Surya Road Lines' },
        create: {
          name: 'Surya Road Lines',
          code: 'SURYA',
          phone: '9440216173',
          city: 'Punganur',
          state: 'Andhra Pradesh',
          pincode: '517247',
          gstin: '37AACBS0915N1ZP',
          contactPerson: 'Jagan',
          defaultRetention: 3000,
          active: true,
        },
      });

      const { row: knm } = await ensureRow(prisma.transport as never, {
        where: { name: 'KNM Transport' },
        create: {
          name: 'KNM Transport',
          code: 'KNM',
          defaultRetention: 0,
          active: true,
        },
      });

      // Backfill existing SaleDispatch records
      // These need no guard of their own: a bulk operation that matches
      // nothing is dropped by the audit extension (see affectedCount), so a
      // boot where there is nothing to backfill writes no row.
      if (surya) {
        await prisma.saleDispatch.updateMany({
          where: { transportId: null, transportProvider: 'SURYA' },
          data: { transportId: surya.id as string },
        });
      }
      if (knm) {
        await prisma.saleDispatch.updateMany({
          where: { transportId: null, transportProvider: 'KNM' },
          data: { transportId: knm.id as string },
        });
      }

      // The house transporter's agreed terms: a flat rate per lorry per
      // destination, and the ₹300 lorry association fee every one of his trips
      // carries. Both were being applied by hand.
      //
      // Found by the distinctive half of the name rather than created by it:
      // the row is already there under whichever of "Madhupuri Transport" and
      // "Sree Madhupuri Transport" the office typed, and a second one would
      // split his ledger in two. Seeded ONCE - the condition is an agency with
      // no rates and no fee, which is what "never configured" looks like - so
      // a rate the office later edits, or a lane it deletes, is never stamped
      // back on the next restart.
      const madhupuri = await prisma.transport.findFirst({
        where: { name: { contains: 'adhupuri', mode: 'insensitive' } },
        select: { id: true, associationFeePerTrip: true, _count: { select: { freightRates: true } } },
      });
      if (madhupuri && madhupuri._count.freightRates === 0 && Number(madhupuri.associationFeePerTrip) === 0) {
        // ₹ per 35 t lorry, Punganur to each lane, as agreed Nov 2026.
        const lanes: Array<[string, number]> = [
          ['AUSA', 63_000],
          ['BARSHI', 52_500],
          ['SHAHADA', 80_000],
          ['SILVASSA', 80_000],
          ['SURAT', 80_000],
          ['AHILYANAGAR', 66_500],
        ];
        await prisma.transportFreightRate.createMany({
          data: lanes.map(([destination, flatAmount]) => ({
            transportId: madhupuri.id,
            destination,
            flatAmount,
            forTonnageKg: 35_000,
          })),
        });
        await prisma.transport.update({
          where: { id: madhupuri.id },
          data: { associationFeePerTrip: 300 },
        });
        logger.info(`[boot] seeded ${lanes.length} agreed trip rates and the ₹300 association fee for Madhupuri Transport`);
      }

      // Ensure existing dispatches for transports with association fee
      // (e.g. Madhupuri) reflect the tiered metric:
      // Below 30 tons (< 30,000 kg): ₹200; 30 tons and above (>= 30,000 kg): ₹300.
      if (madhupuri) {
        const baseFee = Number(madhupuri.associationFeePerTrip || 300);
        const dispatches = await prisma.saleDispatch.findMany({
          where: { transportId: madhupuri.id },
          select: { id: true, weightKg: true, freightDeductions: true },
        });
        for (const d of dispatches) {
          const expectedFee = calcAssociationFee(baseFee, d.weightKg);
          const raw = Array.isArray(d.freightDeductions) ? (d.freightDeductions as any[]) : [];
          let changed = false;
          const updated = raw.map((item) => {
            if (String(item.label || '').trim().toLowerCase() === 'lorry association fee') {
              if (Number(item.amount) !== expectedFee) {
                changed = true;
                return { label: 'Lorry association fee', amount: expectedFee };
              }
            }
            return item;
          });
          if (changed) {
            await prisma.saleDispatch.update({
              where: { id: d.id },
              data: { freightDeductions: updated as any },
            });
            logger.info(`[boot] updated association fee for dispatch ${d.id} (${d.weightKg} kg) -> ₹${expectedFee}`);
          }
        }
      }
      // The agreed rate card now carries three figures a lane (35 t, 30 t and
      // per tonne under 30 t), and bookings that arrived without a requirement
      // code were filed with no freight at all. Both are put right once, here.
      await syncTransportRateCards();
    } catch(e) {
      logger.error(e);
    }
  }
  );

  // Turn on automatic audit capture. Until this runs the Prisma extension is
  // an inert passthrough, so nothing written during boot bootstrap is audited
  // as if a person had done it.
  import("./services/audit.service.js")
    .then(({ registerAuditCapture }) => registerAuditCapture())
    .catch((err) => logger.error("[audit] failed to register capture:", err));

  // Wire up how an approved master change is actually carried out. Without
  // this, a bank-detail change could be requested and approved but would fail
  // loudly at the point of being applied.
  import("./services/masterChange.service.js")
    .then(({ registerMasterAppliers }) => registerMasterAppliers())
    .catch((err) => logger.error("[maker-checker] failed to register appliers:", err));

  // Register in-process WhatsApp cron jobs (daily dues/dispatch, weekly summary).
  // No-op unless WHATSAPP_CRON_ENABLED=true; isolated so it can never crash boot.
  import("./jobs/whatsappJobs.js")
    .then(({ registerWhatsappCron }) => registerWhatsappCron())
    .catch((err) => logger.error("[whatsapp-cron] failed to register:", err));

  // Daily sweep that posts recurring subscription fees as they fall due.
  import("./jobs/subscriptionExpenseJobs.js")
    .then(({ registerSubscriptionCron }) => registerSubscriptionCron())
    .catch((err) => logger.error("[subscription-cron] failed to register:", err));

  // Nightly sweep that keeps the storage bucket from becoming an archive of
  // sent documents again. Deletes files unattended, so it says at boot whether
  // it is on, and records every run in the audit trail.
  import("./jobs/storagePruneJob.js")
    .then(({ registerStoragePruneCron }) => registerStoragePruneCron())
    .catch((err) => logger.error("[storage-prune] failed to register:", err));

  // Poll the GPS provider for lorry positions. No-op without LOCANIX_API_KEY.
  // The retention sweep registers either way - pings already written still
  // have to age out, or the trail fills the database on its own.
  import("./jobs/gpsPollJob.js")
    .then(({ registerGpsPollCron, registerGpsRetentionCron }) => {
      registerGpsPollCron();
      registerGpsRetentionCron();
    })
    .catch((err) => logger.error("[locanix] failed to register poll:", err));
});






