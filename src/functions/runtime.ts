import { CategoryVersions } from '../cache/category-versions';
import { Config } from '../config';
import { PricingPipeline } from '../domain/pricing/pipeline';
import { BlobStore } from '../infra/blob/blob-store';
import { Db } from '../infra/db';
import { MessageQueue } from '../infra/queue/queue';
import { Clock, PricingService } from '../pricing/pricing-service';

/**
 * Serverless-shaped functions: `(event, deps, ctx) => Promise<result>`.
 * Stateless — everything they need to resume lives in Postgres / object storage /
 * the queue message. A thin adapter maps them to the platform trigger:
 *   AWS:   SQS -> Lambda handler, S3 ObjectCreated -> Lambda
 *   Azure: Queue trigger / Blob trigger Functions
 *   Local: BullMQ Worker (src/workers/local-runner.ts)
 */
export interface FunctionContext {
  /** Epoch ms at which the platform will kill this invocation. */
  deadline: number;
  remainingMs(): number;
}

export function makeContext(timeoutMs: number): FunctionContext {
  const deadline = Date.now() + timeoutMs;
  return { deadline, remainingMs: () => deadline - Date.now() };
}

export interface FunctionDeps {
  db: Db;
  blob: BlobStore;
  queue: MessageQueue;
  pricing: PricingService;
  versions: CategoryVersions;
  pipeline: PricingPipeline;
  clock: Clock;
  config: Pick<Config, 'INGEST_CHUNK_SIZE' | 'FUNCTION_SAFETY_MARGIN_MS'>;
}

export class FunctionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`function exceeded its ${timeoutMs}ms timeout and was terminated`);
  }
}

/** Simulates the platform's hard kill so local runs behave like the real thing. */
export async function withHardTimeout<T>(timeoutMs: number, run: (ctx: FunctionContext) => Promise<T>): Promise<T> {
  const ctx = makeContext(timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  const killed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FunctionTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([run(ctx), killed]);
  } finally {
    clearTimeout(timer);
  }
}
