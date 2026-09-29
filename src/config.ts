import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:56379'),
  PORT: z.coerce.number().int().default(3100),
  BLOB_DIR: z.string().default('./.data/blobs'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3100'),
  UPLOAD_SIGNING_SECRET: z.string().default('dev-only-secret'),
  /** Simulated serverless hard timeout for queue-triggered functions. */
  FUNCTION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Stop work and checkpoint when less than this much time is left. */
  FUNCTION_SAFETY_MARGIN_MS: z.coerce.number().int().nonnegative().default(15_000),
  INGEST_CHUNK_SIZE: z.coerce.number().int().positive().default(1000),
  RECOMPUTE_BATCH_SIZE: z.coerce.number().int().positive().default(5000),
  LISTING_CACHE_TTL_S: z.coerce.number().int().positive().default(60),
  PRODUCT_CACHE_TTL_S: z.coerce.number().int().positive().default(300),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
