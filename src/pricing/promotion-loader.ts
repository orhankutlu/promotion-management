import { Prisma } from '@prisma/client';
import { ResolvablePromotion } from '../domain/promotion-resolver';
import { Db, Tx } from '../infra/db';

interface PromotionRow {
  id: string;
  discount_type: 'PERCENTAGE' | 'FIXED';
  value: number;
  starts_at: Date;
  ends_at: Date;
  cancelled_at: Date | null;
  scope: 'PRODUCT' | 'CATEGORY' | null;
  target_product_id: string | null;
  target_category_id: string | null;
}

const toResolvable = (r: PromotionRow): ResolvablePromotion => ({
  id: r.id,
  discountType: r.discount_type,
  value: r.value,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  cancelledAt: r.cancelled_at,
  scope: r.scope,
  targetProductId: r.target_product_id,
  targetCategoryId: r.target_category_id,
});

/**
 * Loads every live (not cancelled, not yet ended) promotion that could affect any of
 * the given products or categories — in one query. Ingestion calls this once per
 * chunk and resolves all rows in memory, instead of one resolver query per row.
 */
export async function loadLivePromotions(
  db: Db | Tx,
  scope: { productIds: string[]; categoryIds: string[] },
  now: Date,
): Promise<ResolvablePromotion[]> {
  if (scope.productIds.length === 0 && scope.categoryIds.length === 0) return [];
  const rows = await db.$queryRaw<PromotionRow[]>(Prisma.sql`
    SELECT id, discount_type, value, starts_at, ends_at, cancelled_at, scope,
           target_product_id, target_category_id
    FROM promotions
    WHERE cancelled_at IS NULL
      AND ends_at > ${now}::timestamptz
      AND (   (scope = 'PRODUCT'  AND target_product_id  = ANY(${scope.productIds}::uuid[]))
           OR (scope = 'CATEGORY' AND target_category_id = ANY(${scope.categoryIds}::uuid[])))
  `);
  return rows.map(toResolvable);
}
