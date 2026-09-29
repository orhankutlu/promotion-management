/**
 * Seeds a large category for the flash-sale demo.
 *   npm run seed -- --category Accessories --products 50000
 *
 * Products are bulk-inserted with generate_series (seeding speed is not what we are
 * demonstrating), then priced through the real set-based recompute path.
 */
import { Prisma } from '@prisma/client';
import { loadConfig } from '../src/config';
import { buildContainer } from '../src/container';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1]!);
const categoryName = args.get('category') ?? 'Accessories';
const count = Number(args.get('products') ?? 50_000);

async function main() {
  const c = buildContainer(loadConfig());
  try {
    const cat = await c.db.category.upsert({ where: { name: categoryName }, create: { name: categoryName }, update: {} });
    const prefix = `SEED-${categoryName.slice(0, 3).toUpperCase()}`;
    const t0 = Date.now();
    await c.db.$executeRaw(Prisma.sql`
      INSERT INTO products (sku, name, category_id, base_price_minor, stock_quantity)
      SELECT ${prefix} || '-' || lpad(g::text, 7, '0'),
             ${categoryName} || ' item ' || g,
             ${cat.id}::uuid,
             999 + (g * 7919) % 150000,
             g % 100
      FROM generate_series(1, ${count}) AS g
      ON CONFLICT (sku) DO NOTHING
    `);
    const t1 = Date.now();
    const { changed, batches } = await c.pricing.recomputeCategory(cat.id);
    console.log(
      JSON.stringify({
        categoryId: cat.id,
        category: categoryName,
        products: count,
        insertMs: t1 - t0,
        priceRecompute: { changed, batches, ms: Date.now() - t1 },
      }),
    );
  } finally {
    await c.close();
  }
}

void main();
