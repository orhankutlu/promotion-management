import { Router } from 'express';
import { z } from 'zod';
import { BlobExistsError, LocalBlobStore } from '../../infra/blob/blob-store';
import { HttpError } from '../../http/errors';
import { IngestionService } from './ingestion-service';

const idParam = z.object({ id: z.string().uuid() });

export function ingestionRoutes(service: IngestionService): Router {
  const r = Router();

  r.post('/jobs', async (_req, res) => {
    res.status(201).json(await service.createJob());
  });

  r.post('/jobs/:id/start', async (req, res) => {
    res.status(202).json(await service.start(idParam.parse(req.params).id));
  });

  r.get('/jobs/:id', async (req, res) => {
    res.json(await service.status(idParam.parse(req.params).id));
  });

  r.post('/jobs/:id/retry-failed', async (req, res) => {
    res.status(202).json(await service.retryFailed(idParam.parse(req.params).id));
  });

  return r;
}

/**
 * Local stand-in for a presigned S3/Azure PUT. Streams the body to disk: the file
 * is never buffered in memory. Not part of the deployed API surface.
 *
 * The URL is create-only (conditional PUT, `If-None-Match: *`): once a file has
 * landed it cannot be replaced, because the dispatcher resumes from byte offsets
 * checkpointed against THAT file. A corrected file goes into a new job.
 */
export function blobUploadRoute(blob: LocalBlobStore): Router {
  const r = Router();
  r.put('/', async (req, res) => {
    const q = z.object({ key: z.string(), expires: z.coerce.number(), sig: z.string() }).parse(req.query);
    if (!blob.verify(q.key, q.expires, q.sig)) throw new HttpError(403, 'BAD_SIGNATURE', 'invalid or expired upload URL');
    try {
      const bytes = await blob.putStream(q.key, req, { ifAbsent: true });
      res.status(200).json({ key: q.key, bytes });
    } catch (err) {
      if (err instanceof BlobExistsError) {
        throw new HttpError(409, 'ALREADY_UPLOADED', 'file already uploaded for this job; create a new job to upload another');
      }
      throw err;
    }
  });
  return r;
}
