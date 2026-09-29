import { parse } from 'csv-parse';
import { Db } from '../infra/db';
import { IngestDispatchMessage } from '../infra/queue/queue';
import { logger } from '../infra/logger';
import { finalizeIfComplete } from './ingest-finalize';
import { FunctionContext, FunctionDeps } from './runtime';

export interface ChunkRow {
  /** 1-based data row number in the vendor file (header excluded). */
  rowNumber: number;
  row: Record<string, string>;
}

export const chunkBlobKey = (jobId: string, index: number) => `chunks/${jobId}/${index}.json`;

/**
 * Splits an uploaded vendor file into fixed-size chunks and fans them out to the
 * queue. Never loads the file: it streams from object storage with a ranged read,
 * so memory is bounded by ONE chunk regardless of file size.
 *
 * Timeout safety: after each emitted chunk it checkpoints the byte offset of the
 * next record (csv-parse `info.bytes` — a true record boundary, correct across
 * quoted newlines and multibyte UTF-8). When the remaining time drops below the
 * safety margin it stops and re-enqueues itself; the next invocation resumes from
 * the checkpoint with a ranged read.
 *
 * Idempotency: chunk boundaries are a pure function of the row index
 * (index = row / chunkSize), so a redelivered or resumed dispatch re-emits the
 * exact same chunks; chunk rows are insert-if-absent and queue sends are deduped.
 */
export async function ingestDispatcher(
  event: IngestDispatchMessage,
  deps: FunctionDeps,
  ctx: FunctionContext,
): Promise<{ status: 'noop' | 'continued' | 'dispatched'; chunksEmitted: number }> {
  const { db, blob, queue, config } = deps;
  const chunkSize = config.INGEST_CHUNK_SIZE;
  const job = await db.ingestionJob.findUnique({ where: { id: event.jobId } });
  if (!job || job.dispatchDone || job.status === 'AWAITING_UPLOAD') return { status: 'noop', chunksEmitted: 0 };

  await db.ingestionJob.update({
    where: { id: job.id },
    data: { dispatchInvocations: { increment: 1 }, updatedAt: new Date() },
  });

  const startOffset = Number(job.dispatchByteOffset);
  let rowIndex = job.dispatchRowIndex;
  let header = job.csvHeader;
  let buffer: ChunkRow[] = [];
  let emitted = 0;

  const source = blob.getStream(job.blobKey, startOffset);
  const parser = source.pipe(
    parse({ info: true, bom: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: false }),
  );

  const emit = async (rows: ChunkRow[]) => {
    const chunkIndex = Math.floor((rows[0]!.rowNumber - 1) / chunkSize);
    const key = chunkBlobKey(job.id, chunkIndex);
    await blob.put(key, JSON.stringify(rows));
    await db.ingestionChunk.upsert({
      where: { jobId_chunkIndex: { jobId: job.id, chunkIndex } },
      create: { jobId: job.id, chunkIndex, blobKey: key, rowCount: rows.length },
      update: {}, // already emitted by an earlier (crashed/redelivered) invocation
    });
    await queue.send('ingest-chunk', { jobId: job.id, chunkIndex }, { dedupeKey: `chunk-${job.id}-${chunkIndex}` });
    emitted++;
  };

  try {
    for await (const { record, info } of parser as AsyncIterable<{ record: string[]; info: { bytes: number } }>) {
      const endOffset = startOffset + info.bytes;
      if (header.length === 0) {
        header = record.map((h) => h.trim().toLowerCase());
        await db.ingestionJob.update({
          where: { id: job.id },
          data: { csvHeader: header, dispatchByteOffset: endOffset },
        });
        continue;
      }
      const row: Record<string, string> = {};
      header.forEach((h, i) => (row[h] = record[i] ?? ''));
      buffer.push({ rowNumber: rowIndex + buffer.length + 1, row });

      if (buffer.length === chunkSize) {
        await emit(buffer);
        rowIndex += buffer.length;
        buffer = [];
        await db.ingestionJob.update({
          where: { id: job.id },
          data: { dispatchByteOffset: endOffset, dispatchRowIndex: rowIndex, updatedAt: new Date() },
        });
        if (ctx.remainingMs() < config.FUNCTION_SAFETY_MARGIN_MS) {
          // Self-continuation: hand the rest of the file to a fresh invocation.
          await queue.send('ingest-dispatch', { jobId: job.id }, { dedupeKey: `dispatch-${job.id}-${rowIndex}` });
          logger.info({ jobId: job.id, rowIndex, endOffset }, 'dispatcher near timeout; continuing in new invocation');
          return { status: 'continued', chunksEmitted: emitted };
        }
      }
    }
  } finally {
    source.destroy();
  }

  if (buffer.length > 0) {
    await emit(buffer);
    rowIndex += buffer.length;
  }
  await db.ingestionJob.update({
    where: { id: job.id },
    data: {
      dispatchDone: true,
      dispatchRowIndex: rowIndex,
      dispatchByteOffset: await blob.size(job.blobKey),
      rowsTotal: rowIndex,
      chunksTotal: Math.ceil(rowIndex / chunkSize),
      status: 'PROCESSING',
      updatedAt: new Date(),
    },
  });
  await finalizeIfComplete(db, job.id);
  return { status: 'dispatched', chunksEmitted: emitted };
}

/**
 * DLQ handler: the queue gave up on the dispatcher (e.g. unparseable CSV). Surfaces
 * the error on the job; chunks already emitted keep processing. retry-failed resumes
 * from the last checkpoint.
 */
export async function onDispatchExhausted(db: Db, event: IngestDispatchMessage, error: string): Promise<void> {
  await db.ingestionJob.updateMany({
    where: { id: event.jobId, dispatchDone: false },
    data: { status: 'FAILED', lastError: error.slice(0, 2000), updatedAt: new Date() },
  });
}
