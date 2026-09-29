import { Job, Queue, Worker } from 'bullmq';
import { loadConfig } from '../config';
import { buildContainer } from '../container';
import { ingestChunkWorker, onChunkExhausted } from '../functions/ingest-chunk-worker';
import { ingestDispatcher, onDispatchExhausted } from '../functions/ingest-dispatcher';
import { priceSweepFunction, recomputeCategoryFunction } from '../functions/price-functions';
import { FunctionDeps, withHardTimeout } from '../functions/runtime';
import { DEFAULT_JOB_OPTIONS } from '../infra/queue/bullmq';
import { IngestChunkMessage, IngestDispatchMessage, QueueName } from '../infra/queue/queue';
import { logger } from '../infra/logger';

/**
 * Local stand-in for the serverless platform: one BullMQ Worker per queue invokes
 * the corresponding stateless function with a hard timeout, exactly like a
 * queue-triggered Lambda / Azure Function would. Scale out by running more
 * copies of this process.
 */

type Fn = (event: never, deps: FunctionDeps, ctx: never) => Promise<unknown>;

const config = loadConfig();
const c = buildContainer(config);
const connection = { url: config.REDIS_URL };

const functions: Record<QueueName, { fn: Fn; concurrency: number }> = {
  'ingest-dispatch': { fn: ingestDispatcher as Fn, concurrency: 1 },
  'ingest-chunk': { fn: ingestChunkWorker as Fn, concurrency: 4 },
  'price-recompute': { fn: recomputeCategoryFunction as Fn, concurrency: 2 },
  'price-sweep': { fn: priceSweepFunction as Fn, concurrency: 1 },
};

const workers = Object.entries(functions).map(([name, { fn, concurrency }]) => {
  const worker = new Worker(
    name,
    async (job: Job) => {
      const started = Date.now();
      const result = await withHardTimeout(config.FUNCTION_TIMEOUT_MS, (ctx) =>
        (fn as (e: unknown, d: FunctionDeps, x: unknown) => Promise<unknown>)(job.data, c, ctx),
      );
      logger.info({ fn: name, jobId: job.id, ms: Date.now() - started, result }, 'function completed');
      return result;
    },
    { connection, concurrency, lockDuration: config.FUNCTION_TIMEOUT_MS + 5_000 },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.warn({ fn: name, jobId: job.id, attempt: job.attemptsMade, exhausted, err: err.message }, 'function failed');
    // Dead-letter handling: surface on the job instead of leaving it stuck.
    if (exhausted && name === 'ingest-chunk') {
      await onChunkExhausted(c.db, job.data as IngestChunkMessage, err.message);
    }
    if (exhausted && name === 'ingest-dispatch') {
      await onDispatchExhausted(c.db, job.data as IngestDispatchMessage, err.message);
    }
  });
  return worker;
});

// Timer trigger for the price sweeper (promotion start/end safety net).
const sweepQueue = new Queue('price-sweep', { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
void sweepQueue.upsertJobScheduler('price-sweep-every-interval', { every: config.SWEEP_INTERVAL_MS }, { data: {} });

logger.info({ queues: Object.keys(functions), timeoutMs: config.FUNCTION_TIMEOUT_MS }, 'local function runner started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await Promise.all(workers.map((w) => w.close()));
    await sweepQueue.close();
    await c.close();
    process.exit(0);
  });
}
