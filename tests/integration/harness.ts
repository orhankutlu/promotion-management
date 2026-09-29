import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import request from 'supertest';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { buildContainer, Container } from '../../src/container';
import { ingestChunkWorker } from '../../src/functions/ingest-chunk-worker';
import { ingestDispatcher } from '../../src/functions/ingest-dispatcher';
import { recomputeCategoryFunction } from '../../src/functions/price-functions';
import { FunctionContext, makeContext } from '../../src/functions/runtime';
import { InMemoryQueue } from '../../src/infra/queue/queue';
import { Clock } from '../../src/pricing/pricing-service';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './env';

export class FakeClock implements Clock {
  constructor(public t = new Date('2026-10-01T12:00:00Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
  iso(offsetMs = 0): string {
    return new Date(this.t.getTime() + offsetMs).toISOString();
  }
}

export const HOUR = 3_600_000;

export interface Harness {
  c: Container;
  queue: InMemoryQueue;
  clock: FakeClock;
  http: ReturnType<typeof request>;
  /** Delivers every pending price-recompute message (what the worker would do). */
  drainRecomputes(): Promise<void>;
  /** Runs the dispatcher (with self-continuations) then every chunk message. */
  drainIngestion(opts?: { ctx?: () => FunctionContext }): Promise<{ dispatchInvocations: number }>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export function createHarness(overrides: Partial<Record<string, string>> = {}): Harness {
  const queue = new InMemoryQueue();
  const clock = new FakeClock();
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    BLOB_DIR: mkdtempSync(join(tmpdir(), 'modaco-blobs-')),
    RECOMPUTE_BATCH_SIZE: '200',
    INGEST_CHUNK_SIZE: '500',
    FUNCTION_SAFETY_MARGIN_MS: '1000',
    ...overrides,
  } as NodeJS.ProcessEnv);
  const redis = new Redis(TEST_REDIS_URL);
  const c = buildContainer(config, { queue, clock, redis });
  const http = request(createApp(c));

  return {
    c,
    queue,
    clock,
    http,
    async drainRecomputes() {
      for (const msg of queue.take('price-recompute')) {
        await recomputeCategoryFunction(msg, c, makeContext(60_000));
      }
    },
    async drainIngestion(opts = {}) {
      let invocations = 0;
      for (;;) {
        const msgs = queue.take('ingest-dispatch');
        if (msgs.length === 0) break;
        for (const m of msgs) {
          invocations++;
          await ingestDispatcher(m, c, opts.ctx?.() ?? makeContext(60_000));
        }
      }
      for (const m of queue.take('ingest-chunk')) await ingestChunkWorker(m, c, makeContext(60_000));
      return { dispatchInvocations: invocations };
    },
    async reset() {
      queue.take('price-recompute');
      queue.take('ingest-dispatch');
      queue.take('ingest-chunk');
      await c.db.$executeRawUnsafe(
        'TRUNCATE product_prices, promotions, products, categories, ingestion_row_errors, ingestion_chunks, ingestion_jobs CASCADE',
      );
      await redis.flushdb();
    },
    async close() {
      await c.close();
    },
  };
}

export async function seedCategory(h: Harness, name: string): Promise<string> {
  const res = await h.http.post('/categories').send({ name }).expect(201);
  return res.body.id;
}

export async function seedProduct(
  h: Harness,
  categoryId: string,
  sku: string,
  basePriceMinor: number,
): Promise<string> {
  const res = await h.http
    .post('/products')
    .send({ sku, name: `Product ${sku}`, categoryId, basePriceMinor, stockQuantity: 10 })
    .expect(201);
  return res.body.id;
}
