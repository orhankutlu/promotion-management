import { resolvePrice, ResolvablePromotion } from '../../src/domain/promotion-resolver';
import { loadLivePromotions } from '../../src/pricing/promotion-loader';
import { recomputeProductIds } from '../../src/pricing/recompute-sql';
import { createHarness, Harness, HOUR } from './harness';

/**
 * The set-based SQL recompute and the TypeScript resolver implement the same rules
 * twice (one for bulk, one for single rows / ingestion). This test generates random
 * catalogs + promotion calendars and asserts both produce identical rows at many
 * instants — the guard against the two implementations drifting apart.
 */

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reset());

// Small deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

it('SQL recompute == TS resolver across random calendars', async () => {
  const rand = rng(42);
  const t0 = h.clock.now().getTime();
  const cats = await Promise.all(['A', 'B', 'C'].map((name) => h.c.db.category.create({ data: { name } })));
  const products = [];
  for (let i = 0; i < 60; i++) {
    products.push(
      await h.c.db.product.create({
        data: {
          sku: `S${i}`,
          name: `P${i}`,
          categoryId: cats[i % 3]!.id,
          basePriceMinor: Math.floor(rand() * 100_000) + (i % 7 === 0 ? 1 : 0),
        },
      }),
    );
  }

  // Non-overlapping windows per target (the DB forbids overlap), random types/values.
  const targets = [
    ...cats.map((c) => ({ scope: 'CATEGORY' as const, targetCategoryId: c.id })),
    ...products.filter((_, i) => i % 4 === 0).map((p) => ({ scope: 'PRODUCT' as const, targetProductId: p.id })),
  ];
  for (const target of targets) {
    let cursor = t0 - 5 * HOUR;
    for (let k = 0; k < 3; k++) {
      const start = cursor + Math.floor(rand() * 3 * HOUR);
      const end = start + Math.floor(rand() * 4 * HOUR) + 60_000;
      const pct = rand() < 0.6;
      await h.c.db.promotion.create({
        data: {
          name: 'rand',
          discountType: pct ? 'PERCENTAGE' : 'FIXED',
          value: pct ? Math.floor(rand() * 10_000) + 1 : Math.floor(rand() * 60_000) + 1,
          startsAt: new Date(start),
          endsAt: new Date(end),
          cancelledAt: rand() < 0.15 ? new Date(t0) : null,
          ...target,
        },
      });
      cursor = end;
    }
  }

  const ids = products.map((p) => p.id);
  for (let step = -6; step <= 12; step++) {
    const now = new Date(t0 + step * HOUR + 1_234);
    await recomputeProductIds(h.c.db, ids, now);
    const sqlRows = await h.c.db.productPrice.findMany();
    const promos: ResolvablePromotion[] = await loadLivePromotions(
      h.c.db,
      { productIds: ids, categoryIds: cats.map((c) => c.id) },
      now,
    );
    for (const p of products) {
      const ts = resolvePrice(p, promos, now);
      const sql = sqlRows.find((r) => r.productId === p.id)!;
      expect({ id: p.id, at: now.toISOString(), ...ts }).toEqual({
        id: p.id,
        at: now.toISOString(),
        effectivePriceMinor: sql.effectivePriceMinor,
        promotionId: sql.promotionId,
        validUntil: sql.validUntil,
      });
    }
  }
});
