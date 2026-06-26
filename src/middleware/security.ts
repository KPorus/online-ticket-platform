import { Request, Response, NextFunction } from 'express';

/**
 * Lightweight, dependency-free NoSQL-injection guard. Recursively strips any object keys that
 * start with `$` (Mongo operators like $gt/$where) or contain `.` (dotted path injection) from
 * the request body, query, and params - mutating in place so we never reassign read-only getters.
 */
function scrub(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj as Record<string, unknown>)) {
    if (k.startsWith('$') || k.includes('.')) {
      delete (obj as Record<string, unknown>)[k];
      continue;
    }
    const value = (obj as Record<string, unknown>)[k];
    if (value && typeof value === 'object') scrub(value);
  }
}

export function sanitizeRequest(req: Request, _res: Response, next: NextFunction): void {
  scrub(req.body);
  scrub(req.query);
  scrub(req.params);
  next();
}

/**
 * HTTP Parameter Pollution guard: when a query key is supplied multiple times Express parses it
 * into an array. Code here expects scalars (e.g. `from`, `sort`, `holderId`), so we collapse to
 * the last value to avoid type confusion.
 */
export function preventParamPollution(req: Request, _res: Response, next: NextFunction): void {
  const query = req.query as Record<string, unknown>;
  for (const k of Object.keys(query)) {
    const value = query[k];
    if (Array.isArray(value)) {
      query[k] = value[value.length - 1];
    }
  }
  next();
}
