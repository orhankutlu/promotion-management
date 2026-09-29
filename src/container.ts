import Redis from 'ioredis';
import { Cache } from './cache/cache';
import { CategoryVersions } from './cache/category-versions';
import { Config } from './config';
import { defaultPricingPipeline } from './domain/pricing/rules';
import { FunctionDeps } from './functions/runtime';
import { LocalBlobStore } from './infra/blob/blob-store';
import { createDb, Db } from './infra/db';
import { BullMqQueue } from './infra/queue/bullmq';
import { MessageQueue } from './infra/queue/queue';
import { IngestionService } from './modules/ingestion/ingestion-service';
import { ProductService } from './modules/products/product-service';
import { PromotionService } from './modules/promotions/promotion-service';
import { Clock, PricingService, systemClock } from './pricing/pricing-service';

export interface Container extends FunctionDeps {
  config: Config;
  redis: Redis;
  blob: LocalBlobStore;
  cache: Cache;
  products: ProductService;
  promotions: PromotionService;
  ingestion: IngestionService;
  close(): Promise<void>;
}

export function buildContainer(
  config: Config,
  overrides: { db?: Db; queue?: MessageQueue; clock?: Clock; redis?: Redis } = {},
): Container {
  const db = overrides.db ?? createDb(config.DATABASE_URL);
  const redis = overrides.redis ?? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  const queue = overrides.queue ?? new BullMqQueue(config.REDIS_URL);
  const clock = overrides.clock ?? systemClock;
  const blob = new LocalBlobStore(config.BLOB_DIR, config.PUBLIC_BASE_URL, config.UPLOAD_SIGNING_SECRET);
  const cache = new Cache(redis);
  const versions = new CategoryVersions(redis);
  const pricing = new PricingService(db, versions, queue, clock, config.RECOMPUTE_BATCH_SIZE);

  return {
    config,
    db,
    redis,
    queue,
    clock,
    blob,
    cache,
    versions,
    pricing,
    pipeline: defaultPricingPipeline(),
    products: new ProductService(db, cache, versions, pricing, clock, {
      listingSeconds: config.LISTING_CACHE_TTL_S,
      productSeconds: config.PRODUCT_CACHE_TTL_S,
    }),
    promotions: new PromotionService(db, pricing, clock),
    ingestion: new IngestionService(db, blob, queue),
    async close() {
      await queue.close();
      redis.disconnect();
      await db.$disconnect();
    },
  };
}
