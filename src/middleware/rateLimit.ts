import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Resolve the real client IP across common proxy setups (Cloudflare, AWS, Nginx).
 * `trust proxy` is also enabled in app.ts; this helper makes the lookup explicit and proxy-aware.
 */
export function getClientIp(req: Request): string {
  // Cloudflare sets this to the original visitor IP.
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp) return cfIp;

  // X-Forwarded-For may be a comma-separated chain; the first entry is the original client.
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor) return forwardedFor.split(',')[0].trim();
  if (Array.isArray(forwardedFor) && forwardedFor.length) return forwardedFor[0].split(',')[0].trim();

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp) return realIp;

  // Fall back to Express's resolved IP (honours trust proxy) then the raw socket.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Strict limiter for auth endpoints. Keyed by client IP + email so brute-forcing a single account is
 * blocked even when the attacker rotates IPs via a VPN/proxy. We disable the trustProxy /
 * x-forwarded-for validations because the custom proxy-aware keyGenerator above handles the IP.
 */
export const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  message: { success: false, message: 'Too many attempts. Please try again later.' },
  keyGenerator: (req) =>
    `${getClientIp(req)}:${String((req.body as { email?: string } | undefined)?.email || '').toLowerCase()}`,
});

/** Limiter for the checkout endpoint to curb payment-session spam (keyed by client IP + user). */
export const checkoutLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  message: { success: false, message: 'Too many checkout attempts. Please wait a moment.' },
  keyGenerator: (req) => `${getClientIp(req)}:${req.user?.id || 'anon'}`,
});
