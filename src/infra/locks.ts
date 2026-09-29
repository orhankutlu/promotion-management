import { Prisma } from '@prisma/client';
import { Db, Tx } from './db';

/**
 * Per-category advisory locks close the race between "a product is created in a
 * category" and "a category-wide promotion is (re)computed":
 *
 *  - Product writers (POST /products, ingestion chunks) hold a SHARED lock on the
 *    category for the life of their transaction, and read promotions only after
 *    acquiring it. Many writers run concurrently.
 *  - A category recompute first passes an EXCLUSIVE "barrier": it waits until every
 *    writer that started before the promotion committed has finished. Writers that
 *    start after the barrier already see the new promotion, and every product that
 *    existed before it is picked up by the recompute's scan.
 *
 * Without this, a product inserted concurrently with a flash sale can commit after
 * the recompute scanned the category but with a price resolved before the promotion
 * existed: it would silently miss the discount.
 *
 * The barrier only covers NEW products. Updates to existing products (and product-
 * scoped promotions, which take no barrier) are serialized by row locks instead:
 * recomputes lock product rows FOR SHARE (pricing/recompute-sql.ts), so writers
 * must upsert the product row BEFORE loading promotions.
 */

const key = (categoryId: string) => Prisma.sql`hashtextextended(${'category:' + categoryId}, 0)`;

export async function lockCategoriesShared(tx: Tx, categoryIds: Iterable<string>): Promise<void> {
  // Sorted order keeps lock acquisition consistent across transactions.
  for (const id of [...new Set(categoryIds)].sort()) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock_shared(${key(id)})`;
  }
}

export async function categoryWriteBarrier(db: Db, categoryId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${key(categoryId)})`;
  });
}
