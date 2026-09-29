import { Prisma } from '@prisma/client';
import { PriceResolution } from '../domain/promotion-resolver';
import { Tx } from '../infra/db';

export interface PriceRow extends PriceResolution {
  productId: string;
  categoryId: string;
  basePriceMinor: number;
}

/**
 * Bulk upsert of resolved prices (unnest => one statement for up to a whole chunk).
 * Only the pricing paths call this; API handlers never write product_prices directly.
 */
export async function upsertPrices(tx: Tx, rows: PriceRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO product_prices
      (product_id, category_id, base_price_minor, effective_price_minor, promotion_id, valid_until, updated_at)
    SELECT u.product_id, u.category_id, u.base_price_minor, u.effective_price_minor,
           NULLIF(u.promotion_id, '')::uuid, NULLIF(u.valid_until, '')::timestamptz, now()
    FROM unnest(
      ${rows.map((r) => r.productId)}::uuid[],
      ${rows.map((r) => r.categoryId)}::uuid[],
      ${rows.map((r) => r.basePriceMinor)}::int[],
      ${rows.map((r) => r.effectivePriceMinor)}::int[],
      -- Nullable columns travel as text with '' for NULL: an all-NULL JS array gives
      -- the driver no element type to infer, and it guesses integer[].
      ${rows.map((r) => r.promotionId ?? '')}::text[],
      ${rows.map((r) => r.validUntil?.toISOString() ?? '')}::text[]
    ) AS u(product_id, category_id, base_price_minor, effective_price_minor, promotion_id, valid_until)
    ON CONFLICT (product_id) DO UPDATE SET
      category_id           = EXCLUDED.category_id,
      base_price_minor      = EXCLUDED.base_price_minor,
      effective_price_minor = EXCLUDED.effective_price_minor,
      promotion_id          = EXCLUDED.promotion_id,
      valid_until           = EXCLUDED.valid_until,
      updated_at            = now()
  `);
}
