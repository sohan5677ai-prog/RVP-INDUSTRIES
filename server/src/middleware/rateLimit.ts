import rateLimit from 'express-rate-limit';

/**
 * Global limiter applied to every API request. Generous enough for normal ERP
 * use by a small team, but caps runaway/abusive traffic.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

/**
 * Strict limiter for the login endpoint to blunt credential-stuffing / brute
 * force. Only failed responses count toward the limit, so a legitimate user who
 * logs in successfully is never locked out.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

/**
 * Limiter for the AI chat endpoint, which fans out to a paid LLM on every call.
 * Keeps a stolen token or a runaway client from burning the API bill.
 */
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Chat rate limit reached, please wait a moment.' },
});

/**
 * Limiter for the public (unauthenticated) WhatsApp webhook. Fast2SMS is the
 * only expected caller, but the URL has no secret in it — each POST also
 * triggers a DB write and, for text-shaped payloads, a Gemini call, so an
 * anonymous flood could both rack up LLM cost and fill WhatsAppLog. Capped
 * well above real traffic (a burst of inbound replies) but far below abuse
 * volume.
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many webhook requests.' },
});

/**
 * Limiter for the bulk-import parse endpoint. It buffers the whole upload
 * into memory (multer memoryStorage) before parsing, so a few concurrent
 * uploads from one client could pressure memory; this caps how often one
 * client can trigger that even though the route requires auth.
 */
export const bulkImportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many bulk import uploads, please wait a moment.' },
});
