import { Prisma } from '@prisma/client';
import { Db, Tx } from '../infra/db';

/**
 * Set-based price recompute: resolves the winning promotion and effective price for
 * a batch of products in ONE statement, instead of N ORM round-trips. This is what
 * makes a 50k-product flash sale a handful of statements (50k / batch size).
 *
 * The SQL mirrors src/domain/promotion-resolver.ts + money.ts exactly:
 *   - active = not cancelled, starts_at <= now < ends_at
 *   - PRODUCT scope beats CATEGORY scope; tie-break (starts_at, id)
 *   - PERCENTAGE: base - round_half_up(base * bps / 10000), FIXED: base - value, floor 0
 *   - valid_until = LEAST(winner.ends_at, earliest future start)  (LEAST ignores NULLs)
 * tests/integration/pricing-parity.test.ts asserts both implementations agree.
 *
 * Rows whose computed values are unchanged are skipped (IS DISTINCT FROM) so a
 * recompute that changes nothing writes nothing — no WAL churn, no bloat.
 *
 * The product rows are locked FOR SHARE (in id order). Without it the statement
 * prices from its start-of-statement snapshot, so a writer updating the same product
 * concurrently gets its price row overwritten with the OLD base price once it
 * commits, and a product promotion can be overwritten by a writer that resolved its
 * price before the promotion existed. With the lock, the recompute waits for the
 * writer and re-reads the latest row; a writer arriving later waits for the
 * recompute and then sees the promotion, because writers always upsert the product
 * row BEFORE loading promotions (see infra/locks.ts).
 */
export async function recomputeProductIds(
  db: Db | Tx,
  productIds: string[],
  now: Date,
): Promise<{ changed: number; categoryIds: string[] }> {
  if (productIds.length === 0) return { changed: 0, categoryIds: [] };

  const rows = await db.$queryRaw<{ category_id: string }[]>(Prisma.sql`
    WITH target AS (
      SELECT p.id, p.category_id, p.base_price_minor
      FROM products p
      WHERE p.id = ANY(${productIds}::uuid[])
      ORDER BY p.id
      FOR SHARE
    ),
    resolved AS (
      SELECT
        t.id,
        t.category_id,
        t.base_price_minor,
        w.id AS promotion_id,
        CASE
          WHEN w.id IS NULL THEN t.base_price_minor
          WHEN w.discount_type = 'PERCENTAGE'
            THEN GREATEST(0, t.base_price_minor - ((t.base_price_minor::bigint * w.value + 5000) / 10000)::int)
          ELSE GREATEST(0, t.base_price_minor - w.value)
        END AS effective_price_minor,
        LEAST(w.ends_at, nxt.next_start) AS valid_until
      FROM target t
      LEFT JOIN LATERAL (
        SELECT pr.id, pr.discount_type, pr.value, pr.ends_at
        FROM promotions pr
        WHERE pr.cancelled_at IS NULL
          AND pr.starts_at <= ${now}::timestamptz AND pr.ends_at > ${now}::timestamptz
          AND (   (pr.scope = 'PRODUCT'  AND pr.target_product_id  = t.id)
               OR (pr.scope = 'CATEGORY' AND pr.target_category_id = t.category_id))
        ORDER BY (pr.scope = 'PRODUCT') DESC, pr.starts_at, pr.id
        LIMIT 1
      ) w ON true
      LEFT JOIN LATERAL (
        SELECT min(pr.starts_at) AS next_start
        FROM promotions pr
        WHERE pr.cancelled_at IS NULL
          AND pr.starts_at > ${now}::timestamptz
          AND (   (pr.scope = 'PRODUCT'  AND pr.target_product_id  = t.id)
               OR (pr.scope = 'CATEGORY' AND pr.target_category_id = t.category_id))
      ) nxt ON true
    )
    INSERT INTO product_prices AS pp
      (product_id, category_id, base_price_minor, effective_price_minor, promotion_id, valid_until, updated_at)
    SELECT id, category_id, base_price_minor, effective_price_minor, promotion_id, valid_until, now()
    FROM resolved
    ON CONFLICT (product_id) DO UPDATE SET
      category_id           = EXCLUDED.category_id,
      base_price_minor      = EXCLUDED.base_price_minor,
      effective_price_minor = EXCLUDED.effective_price_minor,
      promotion_id          = EXCLUDED.promotion_id,
      valid_until           = EXCLUDED.valid_until,
      updated_at            = now()
    WHERE (pp.category_id, pp.base_price_minor, pp.effective_price_minor, pp.promotion_id, pp.valid_until)
          IS DISTINCT FROM
          (EXCLUDED.category_id, EXCLUDED.base_price_minor, EXCLUDED.effective_price_minor,
           EXCLUDED.promotion_id, EXCLUDED.valid_until)
    RETURNING pp.category_id
  `);

  return { changed: rows.length, categoryIds: [...new Set(rows.map((r) => r.category_id))] };
}

/** Keyset-paginates a category's product ids in id order. */
export async function nextCategoryBatch(
  db: Db,
  categoryId: string,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM products
    WHERE category_id = ${categoryId}::uuid
      ${afterId ? Prisma.sql`AND id > ${afterId}::uuid` : Prisma.empty}
    ORDER BY id
    LIMIT ${limit}
  `);
  return rows.map((r) => r.id);
}

/** Price rows whose promotion window has started or ended since they were computed. */
export async function staleProductIds(db: Db, now: Date, limit: number): Promise<string[]> {
  const rows = await db.$queryRaw<{ product_id: string }[]>(Prisma.sql`
    SELECT product_id FROM product_prices
    WHERE valid_until IS NOT NULL AND valid_until <= ${now}::timestamptz
    ORDER BY valid_until
    LIMIT ${limit}
  `);
  return rows.map((r) => r.product_id);
}
