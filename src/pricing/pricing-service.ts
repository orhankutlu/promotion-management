import { Prisma } from '@prisma/client';
import { CategoryVersions } from '../cache/category-versions';
import { resolvePrice } from '../domain/promotion-resolver';
import { Db, Tx } from '../infra/db';
import { categoryWriteBarrier } from '../infra/locks';
import { logger } from '../infra/logger';
import { MessageQueue } from '../infra/queue/queue';
import { loadLivePromotions } from './promotion-loader';
import { upsertPrices } from './price-writer';
import { nextCategoryBatch, recomputeProductIds, staleProductIds } from './recompute-sql';

export type Propagation = 'COMPLETED' | 'QUEUED' | 'DEFERRED' | 'NONE';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/**
 * Owns every write to product_prices, and the rule for when caches are bumped.
 */
export class PricingService {
  constructor(
    private readonly db: Db,
    private readonly versions: CategoryVersions,
    private readonly queue: MessageQueue,
    private readonly clock: Clock,
    private readonly batchSize: number,
  ) {}

  /**
   * Resolves and writes prices for products inside the caller's transaction (product
   * create, ingestion chunk). Caller must already hold the categories' shared locks.
   */
  async priceProductsInTx(
    tx: Tx,
    products: { id: string; categoryId: string; basePriceMinor: number }[],
  ): Promise<void> {
    const now = this.clock.now();
    const promos = await loadLivePromotions(
      tx,
      { productIds: products.map((p) => p.id), categoryIds: [...new Set(products.map((p) => p.categoryId))] },
      now,
    );
    await upsertPrices(
      tx,
      products.map((p) => ({
        productId: p.id,
        categoryId: p.categoryId,
        basePriceMinor: p.basePriceMinor,
        ...resolvePrice(p, promos, now),
      })),
    );
  }

  /** Single product (product-scoped promotion change): small enough to do inline. */
  async recomputeProduct(productId: string): Promise<void> {
    const { categoryIds } = await recomputeProductIds(this.db, [productId], this.clock.now());
    await this.versions.bump(categoryIds);
  }

  /**
   * Category-wide recompute (flash sale). Runs in a queue worker, never in the HTTP
   * request. Barrier first (see infra/locks.ts), then keyset batches so no single
   * statement holds row locks on 50k rows, then ONE version bump after everything
   * has committed.
   */
  async recomputeCategory(categoryId: string): Promise<{ changed: number; batches: number }> {
    await categoryWriteBarrier(this.db, categoryId);
    // Promotion revisions this run is about to apply (see markSynced / reconcile).
    const applying = await this.db.$queryRaw<{ id: string; rev: number }[]>(Prisma.sql`
      SELECT id, pricing_rev AS rev FROM promotions
      WHERE scope = 'CATEGORY' AND target_category_id = ${categoryId}::uuid
        AND pricing_synced_rev < pricing_rev
    `);
    const now = this.clock.now();
    let after: string | null = null;
    let changed = 0;
    let batches = 0;
    for (;;) {
      const ids = await nextCategoryBatch(this.db, categoryId, after, this.batchSize);
      if (ids.length === 0) break;
      changed += (await recomputeProductIds(this.db, ids, now)).changed;
      batches++;
      after = ids[ids.length - 1]!;
    }
    await this.versions.bump([categoryId]);
    await this.markSynced(applying);
    logger.info({ categoryId, changed, batches }, 'category prices recomputed');
    return { changed, batches };
  }

  /**
   * Time-driven transitions: recompute every row whose valid_until has passed
   * (a promotion started or ended). Safety net behind the delayed jobs scheduled
   * at each promotion's start/end.
   */
  async sweepStale(deadline: number): Promise<number> {
    let total = 0;
    while (Date.now() < deadline) {
      const now = this.clock.now();
      const ids = await staleProductIds(this.db, now, this.batchSize);
      if (ids.length === 0) break;
      const { changed, categoryIds } = await recomputeProductIds(this.db, ids, now);
      await this.versions.bump(categoryIds);
      total += changed;
      if (changed === 0) break; // nothing moved: avoid spinning on rows that stay stale
    }
    return total;
  }

  /**
   * Fan-out for a promotion that was created, assigned or cancelled.
   * Product scope: inline. Category scope: queued now + at the start/end instants.
   * If the queue is unreachable the promotion is still committed; the sweeper's
   * reconcile pass re-drives it (the admin sees pricePropagation: DEFERRED).
   */
  async onPromotionChanged(promo: {
    id: string;
    scope: 'PRODUCT' | 'CATEGORY' | null;
    targetProductId: string | null;
    targetCategoryId: string | null;
    startsAt: Date;
    endsAt: Date;
    pricingRev: number;
  }): Promise<Propagation> {
    if (promo.scope === 'PRODUCT' && promo.targetProductId) {
      await this.recomputeProduct(promo.targetProductId);
      await this.markSynced([{ id: promo.id, rev: promo.pricingRev }]);
      return 'COMPLETED';
    }
    if (promo.scope === 'CATEGORY' && promo.targetCategoryId) {
      const categoryId = promo.targetCategoryId;
      try {
        await this.queue.send('price-recompute', { categoryId, reason: `promotion ${promo.id} changed` });
        const now = this.clock.now().getTime();
        for (const [edge, at] of [['start', promo.startsAt], ['end', promo.endsAt]] as const) {
          const delayMs = at.getTime() - now;
          if (delayMs > 0) {
            await this.queue.send(
              'price-recompute',
              { categoryId, reason: `promotion ${promo.id} ${edge}` },
              { delayMs, dedupeKey: `promo-${promo.id}-${edge}-${at.getTime()}` },
            );
          }
        }
        return 'QUEUED';
      } catch (err) {
        logger.error({ err, promotionId: promo.id }, 'enqueue failed; sweeper will reconcile');
        return 'DEFERRED';
      }
    }
    await this.markSynced([{ id: promo.id, rev: promo.pricingRev }]); // draft: no prices to sync
    return 'NONE';
  }

  /**
   * Re-drives promotions whose latest change was never confirmed applied to prices
   * (lost message, crash between commit and enqueue). `graceMs` leaves time for the
   * normal path to finish so healthy traffic isn't duplicated.
   */
  async reconcileUnsynced(graceMs: number): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - graceMs);
    const stuck = await this.db.$queryRaw<
      { id: string; rev: number; scope: 'PRODUCT' | 'CATEGORY' | null; product_id: string | null; category_id: string | null }[]
    >(Prisma.sql`
      SELECT id, pricing_rev AS rev, scope, target_product_id AS product_id, target_category_id AS category_id
      FROM promotions
      WHERE pricing_synced_rev < pricing_rev AND pricing_changed_at <= ${cutoff}::timestamptz
      ORDER BY pricing_changed_at
      LIMIT 500
    `);
    // Dedupe per grace window, not per revision: a job id that stays constant would be
    // swallowed forever once BullMQ retains it as failed, so a recompute that exhausted
    // its retries (e.g. DB outage) could never be re-driven.
    const window = Math.floor(this.clock.now().getTime() / graceMs);
    for (const p of stuck) {
      if (p.scope === 'CATEGORY' && p.category_id) {
        await this.queue.send(
          'price-recompute',
          { categoryId: p.category_id, reason: `reconcile promotion ${p.id}` },
          { dedupeKey: `reconcile-${p.id}-${p.rev}-${window}` },
        );
      } else {
        if (p.scope === 'PRODUCT' && p.product_id) await this.recomputeProduct(p.product_id);
        await this.markSynced([{ id: p.id, rev: p.rev }]);
      }
    }
    if (stuck.length > 0) logger.warn({ count: stuck.length }, 'reconciled promotions with unsynced prices');
    return stuck.length;
  }

  private async markSynced(revs: { id: string; rev: number }[]): Promise<void> {
    if (revs.length === 0) return;
    await this.db.$executeRaw(Prisma.sql`
      UPDATE promotions p SET pricing_synced_rev = GREATEST(p.pricing_synced_rev, u.rev)
      FROM unnest(${revs.map((r) => r.id)}::uuid[], ${revs.map((r) => r.rev)}::int[]) AS u(id, rev)
      WHERE p.id = u.id
    `);
  }
}
