import { Prisma } from '@prisma/client';
import { BlobStore } from '../../infra/blob/blob-store';
import { Db } from '../../infra/db';
import { MessageQueue } from '../../infra/queue/queue';
import { conflict, notFound } from '../../http/errors';

const UPLOAD_URL_TTL_S = 15 * 60;

export class IngestionService {
  constructor(
    private readonly db: Db,
    private readonly blob: BlobStore,
    private readonly queue: MessageQueue,
  ) {}

  /**
   * Step 1: create the job and hand back a presigned upload URL. The 500k-row file
   * goes straight to object storage — it never passes through (or is held in the
   * memory of) an API function, which has request-size and timeout limits.
   */
  async createJob() {
    const job = await this.db.ingestionJob.create({ data: { blobKey: 'pending' } });
    const blobKey = `uploads/${job.id}.csv`;
    await this.db.ingestionJob.update({ where: { id: job.id }, data: { blobKey } });
    return {
      jobId: job.id,
      upload: { method: 'PUT', url: this.blob.presignPut(blobKey, UPLOAD_URL_TTL_S), expiresInSeconds: UPLOAD_URL_TTL_S },
      next: `POST /ingestion/jobs/${job.id}/start once the upload finished`,
    };
  }

  /**
   * Step 2: in the cloud this is the object-created event (S3 / Event Grid) firing a
   * function; locally it is an explicit call. Guarded so a duplicate event is a no-op.
   */
  async start(jobId: string) {
    const job = await this.db.ingestionJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('ingestion job');
    try {
      await this.blob.size(job.blobKey);
    } catch {
      throw conflict('UPLOAD_MISSING', 'file has not been uploaded yet');
    }
    const { count } = await this.db.ingestionJob.updateMany({
      where: { id: jobId, status: 'AWAITING_UPLOAD' },
      data: { status: 'DISPATCHING', updatedAt: new Date() },
    });
    if (count > 0) await this.queue.send('ingest-dispatch', { jobId }, { dedupeKey: `dispatch-${jobId}-start` });
    return this.status(jobId);
  }

  async status(jobId: string) {
    const job = await this.db.ingestionJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound('ingestion job');
    const [errors, failedChunks] = await Promise.all([
      this.db.ingestionRowError.findMany({ where: { jobId }, orderBy: { rowNumber: 'asc' }, take: 20 }),
      this.db.ingestionChunk.findMany({
        where: { jobId, status: 'FAILED' },
        select: { chunkIndex: true, attempts: true, lastError: true },
        orderBy: { chunkIndex: 'asc' },
        take: 20,
      }),
    ]);
    const pct = job.chunksTotal > 0 ? Math.floor(((job.chunksDone + job.chunksFailed) / job.chunksTotal) * 100) : 0;
    return {
      id: job.id,
      status: job.status,
      error: job.lastError,
      progressPercent: job.dispatchDone ? pct : null,
      rows: { total: job.dispatchDone ? job.rowsTotal : null, ingested: job.rowsIngested, rejected: job.rowsRejected },
      chunks: {
        total: job.dispatchDone ? job.chunksTotal : null,
        done: job.chunksDone,
        failed: job.chunksFailed,
      },
      dispatcher: {
        done: job.dispatchDone,
        rowsDispatched: job.dispatchRowIndex,
        invocations: job.dispatchInvocations,
      },
      sampleRowErrors: errors.map((e) => ({ row: e.rowNumber, sku: e.sku, reason: e.reason })),
      failedChunks,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  /** Re-drives a dead-lettered dispatcher and/or chunks (e.g. after a DB outage has been fixed). */
  async retryFailed(jobId: string) {
    const attempt = Date.now();
    // Dispatcher gave up: resume it from its last checkpoint.
    const { count: dispatch } = await this.db.ingestionJob.updateMany({
      where: { id: jobId, status: 'FAILED', dispatchDone: false },
      data: { status: 'DISPATCHING', lastError: null, updatedAt: new Date() },
    });
    if (dispatch > 0) await this.queue.send('ingest-dispatch', { jobId }, { dedupeKey: `dispatch-${jobId}-r${attempt}` });

    const chunks = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ chunk_index: number }[]>(Prisma.sql`
        UPDATE ingestion_chunks SET status = 'PENDING', attempts = 0, updated_at = now()
        WHERE job_id = ${jobId}::uuid AND status = 'FAILED'
        RETURNING chunk_index
      `);
      if (rows.length > 0) {
        // Status goes back to PROCESSING only once dispatch finished; while the
        // dispatcher is still running it stays DISPATCHING.
        await tx.$executeRaw(Prisma.sql`
          UPDATE ingestion_jobs
          SET chunks_failed = chunks_failed - ${rows.length},
              status = CASE WHEN dispatch_done THEN 'PROCESSING'::"IngestionJobStatus" ELSE status END,
              updated_at = now()
          WHERE id = ${jobId}::uuid
        `);
      }
      return rows.map((r) => r.chunk_index);
    });
    for (const chunkIndex of chunks) {
      await this.queue.send('ingest-chunk', { jobId, chunkIndex }, { dedupeKey: `chunk-${jobId}-${chunkIndex}-r${attempt}` });
    }
    return { requeued: chunks.length + dispatch };
  }
}
