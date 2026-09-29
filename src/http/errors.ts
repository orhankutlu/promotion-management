import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { pgErrorCode } from '../infra/db';
import { logger } from '../infra/logger';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'invalid request', details: err.issues } });
    return;
  }
  const pg = pgErrorCode(err);
  if (pg === '23P01') {
    res.status(409).json({
      error: {
        code: 'PROMOTION_OVERLAP',
        message: 'another live promotion on the same target overlaps this date range',
      },
    });
    return;
  }
  if (pg === '23505') {
    res.status(409).json({ error: { code: 'DUPLICATE', message: 'resource already exists' } });
    return;
  }
  if (pg === '23503') {
    res.status(422).json({ error: { code: 'INVALID_REFERENCE', message: 'referenced resource does not exist' } });
    return;
  }
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
}
