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
