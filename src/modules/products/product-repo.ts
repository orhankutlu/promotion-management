import { Prisma } from '@prisma/client';
import { bpsToPercent } from '../../domain/money';
import { Db } from '../../infra/db';

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  categoryId: string;
  categoryName: string;
  stockQuantity: number;
  basePriceMinor: number;
  effectivePriceMinor: number;
  promotion: { id: string; name: string; discountType: string; value: number; endsAt: string } | null;
  /** ISO time after which this price must be recomputed; null = until next write. */
  priceValidUntil: string | null;
}

interface Row {
  id: string;
  sku: string;
  name: string;
  category_id: string;
  category_name: string;
  stock_quantity: number;
  base_price_minor: number;
  effective_price_minor: number;
  valid_until: Date | null;
  promotion_id: string | null;
  promotion_name: string | null;
  discount_type: string | null;
  promotion_value: number | null;
  promotion_ends_at: Date | null;
}

const toView = (r: Row): ProductView => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  categoryId: r.category_id,
  categoryName: r.category_name,
  stockQuantity: r.stock_quantity,
  basePriceMinor: r.base_price_minor,
  effectivePriceMinor: r.effective_price_minor,
  promotion: r.promotion_id
    ? {
        id: r.promotion_id,
        name: r.promotion_name!,
        discountType: r.discount_type!,
        // Same units as /promotions: percent for PERCENTAGE (stored as bps), minor units for FIXED.
        value: r.discount_type === 'PERCENTAGE' ? bpsToPercent(r.promotion_value!) : r.promotion_value!,
        endsAt: r.promotion_ends_at!.toISOString(),
      }
    : null,
  priceValidUntil: r.valid_until?.toISOString() ?? null,
});

const SELECT = Prisma.sql`
  SELECT p.id, p.sku, p.name, p.category_id, c.name AS category_name, p.stock_quantity,
         pp.base_price_minor, pp.effective_price_minor, pp.valid_until,
         pr.id AS promotion_id, pr.name AS promotion_name, pr.discount_type::text AS discount_type,
         pr.value AS promotion_value, pr.ends_at AS promotion_ends_at
  FROM product_prices pp
  JOIN products p    ON p.id = pp.product_id
  JOIN categories c  ON c.id = p.category_id
  LEFT JOIN promotions pr ON pr.id = pp.promotion_id`;

export type SortDir = 'asc' | 'desc';

export interface ListQuery {
  categoryId?: string;
  sort: SortDir;
  limit: number;
  cursor?: { price: number; id: string };
}

/**
 * Keyset pagination on (effective_price_minor, product_id), served by
 * product_prices_category_price_idx / product_prices_price_idx. Page N costs the
 * same as page 1, and pages don't shift/duplicate when prices change mid-browse
 * the way OFFSET pages do.
 */
export async function listProducts(db: Db, q: ListQuery): Promise<ProductView[]> {
  const cmp = q.sort === 'asc' ? Prisma.sql`>` : Prisma.sql`<`;
  const dir = q.sort === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const where: Prisma.Sql[] = [];
  if (q.categoryId) where.push(Prisma.sql`pp.category_id = ${q.categoryId}::uuid`);
  if (q.cursor) {
    where.push(
      Prisma.sql`(pp.effective_price_minor, pp.product_id) ${cmp} (${q.cursor.price}::int, ${q.cursor.id}::uuid)`,
    );
  }
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    ${SELECT}
    ${where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty}
    ORDER BY pp.effective_price_minor ${dir}, pp.product_id ${dir}
    LIMIT ${q.limit}
  `);
  return rows.map(toView);
}

export async function getProduct(db: Db, id: string): Promise<ProductView | null> {
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE pp.product_id = ${id}::uuid`);
  return rows[0] ? toView(rows[0]) : null;
}
