import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation error',
      details: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    });
    return;
  }

  // Raised by the overlap-guard triggers (migration 003) when a write would double-book a staff member.
  if ((err as { message?: string })?.message === 'APPOINTMENT_OVERLAP') {
    res.status(409).json({ error: 'This time slot is no longer available. Please choose another time.' });
    return;
  }

  // Raised by the resource triggers (migration 013) when a write would over-book a room or other resource.
  if ((err as { message?: string })?.message === 'RESOURCE_UNAVAILABLE') {
    res.status(409).json({ error: 'The room or resource is no longer free at that time. Please choose another time.' });
    return;
  }
  if ((err as { message?: string })?.message === 'RESOURCE_ORG_MISMATCH') {
    res.status(400).json({ error: 'Resource not found' });
    return;
  }

  // Request-body problems reported by express.json(): the client's fault, not a server error.
  const bodyError = err as { type?: string; status?: number };
  if (bodyError?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'The request body is not valid JSON' });
    return;
  }
  if (bodyError?.type === 'entity.too.large') {
    res.status(413).json({ error: 'The request is too large' });
    return;
  }
  if (typeof bodyError?.status === 'number' && bodyError.status >= 400 && bodyError.status < 500 && bodyError.type) {
    res.status(bodyError.status).json({ error: 'The request could not be read' });
    return;
  }

  if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    res.status(409).json({ error: 'This record is still used by other records (for example appointments) and cannot be deleted. Deactivate it instead.' });
    return;
  }

  if (err instanceof Error) {
    // Log full stack server-side but never expose internals to callers
    console.error('[ERROR]', err.name, err.message);
    if (process.env.NODE_ENV !== 'production') {
      console.error(err.stack);
    }
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  console.error('[ERROR] Unknown error type:', err);
  res.status(500).json({ error: 'Internal server error' });
}
