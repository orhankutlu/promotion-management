import { priceSweepFunction } from '../../src/functions/price-functions';
import { makeContext } from '../../src/functions/runtime';
import { resolvePrice } from '../../src/domain/promotion-resolver';
import { lockCategoriesShared } from '../../src/infra/locks';
import { upsertPrices } from '../../src/pricing/price-writer';
import { loadLivePromotions } from '../../src/pricing/promotion-loader';
import { recomputeProductIds } from '../../src/pricing/recompute-sql';
import { createHarness, Harness, HOUR, seedCategory, seedProduct } from './harness';

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const price = async (id: string) => (await h.http.get(`/products/${id}`).expect(200)).body.effectivePriceMinor;

async function categorySale(categoryId: string, percent: number, opts: { startsIn?: number; endsIn?: number } = {}) {
  const res = await h.http.post('/promotions').send({
    name: `${percent}% off`,
    discountType: 'PERCENTAGE',
    value: percent,
    startsAt: h.clock.iso(opts.startsIn ?? 0),
    endsAt: h.clock.iso(opts.endsIn ?? 24 * HOUR),
    target: { scope: 'CATEGORY', categoryId },
  });
  return res;
}

describe('Scenario B — flash sale', () => {
  it('category sale: control-plane write returns immediately, prices propagate via worker', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const ids = await Promise.all([1, 2, 3].map((i) => seedProduct(h, cat, `ACC-${i}`, i * 10_000)));

    const res = await categorySale(cat, 50);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'ACTIVE', pricePropagation: 'QUEUED' });

    // Worker not yet run: listing still reflects pre-sale prices (documented trade-off).
    expect(await price(ids[0]!)).toBe(10_000);

    await h.drainRecomputes();
    expect(await Promise.all(ids.map(price))).toEqual([5_000, 10_000, 15_000]);
  });

  it('product-scoped promotion wins over the category sale and is applied inline', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const a = await seedProduct(h, cat, 'A', 10_000);
    const b = await seedProduct(h, cat, 'B', 10_000);
    await categorySale(cat, 50);
    await h.drainRecomputes();

    const res = await h.http.post('/promotions').send({
      name: '10% on A',
      discountType: 'PERCENTAGE',
      value: 10,
      endsAt: h.clock.iso(HOUR),
      target: { scope: 'PRODUCT', productId: a },
    });
    expect(res.status).toBe(201);
    expect(res.body.pricePropagation).toBe('COMPLETED');
    expect(await price(a)).toBe(9_000); // product promo wins even though shallower
    expect(await price(b)).toBe(5_000);

    // Product promo ends -> A falls back to the category sale.
    h.clock.advance(HOUR);
    expect(await price(a)).toBe(5_000);
  });

  it('a product created while the sale is active is discounted on its first read', async () => {
    const cat = await seedCategory(h, 'Accessories');
    await categorySale(cat, 50);
    await h.drainRecomputes();

    const created = await h.http
      .post('/products')
      .send({ sku: 'NEW-1', name: 'New scarf', categoryId: cat, basePriceMinor: 8_000 })
      .expect(201);
    expect(created.body.effectivePriceMinor).toBe(4_000);
    // Percent, same units as /promotions (stored as 5000 bps).
    expect(created.body.promotion).toMatchObject({ name: '50% off', discountType: 'PERCENTAGE', value: 50 });
  });

  it('recompute waits for an in-flight product write that priced itself before the sale existed', async () => {
    // Deterministic reproduction of the race: a product transaction resolves its
    // price (no sale yet), then stalls before commit. Meanwhile the sale commits and
    // the category recompute runs. Without the advisory-lock barrier the recompute
    // scans before the product is visible, and the product keeps full price forever.
    const cat = await seedCategory(h, 'Accessories');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markPriced!: () => void;
    const priced = new Promise<void>((r) => (markPriced = r));

    const slowWrite = h.c.db.$transaction(
      async (tx) => {
        await lockCategoriesShared(tx, [cat]);
        const p = await tx.product.create({ data: { sku: 'SLOW', name: 'x', categoryId: cat, basePriceMinor: 1_000 } });
        await h.c.pricing.priceProductsInTx(tx, [p]);
        markPriced();
        await gate;
      },
      { timeout: 20_000 },
    );
    await priced;
    await categorySale(cat, 50);
    const recompute = h.drainRecomputes(); // blocks on the barrier until slowWrite commits
    await new Promise((r) => setTimeout(r, 300));
    release();
    await Promise.all([slowWrite, recompute]);

    const row = await h.c.db.productPrice.findFirstOrThrow({ where: { categoryId: cat } });
    expect(row.effectivePriceMinor).toBe(500);
  });

  it('a recompute racing an update to an existing product keeps the new base price', async () => {
    // The barrier only covers writers that started before it. A writer that starts
    // after it (e.g. the next ingestion chunk re-pricing an existing SKU) runs
    // alongside the recompute batches. Without the row lock, the recompute computes
    // from its statement snapshot (old base), waits on the writer's price row, and
    // then overwrites it with the stale base.
    const cat = await seedCategory(h, 'Accessories');
    const id = await seedProduct(h, cat, 'ACC-1', 1_000);
    expect((await categorySale(cat, 50)).status).toBe(202);
    await h.drainRecomputes();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markPriced!: () => void;
    const priced = new Promise<void>((r) => (markPriced = r));

    const update = h.c.db.$transaction(
      async (tx) => {
        await lockCategoriesShared(tx, [cat]);
        const p = await tx.product.update({ where: { id }, data: { basePriceMinor: 2_000 } });
        await h.c.pricing.priceProductsInTx(tx, [p]);
        markPriced();
        await gate;
      },
      { timeout: 20_000 },
    );
    await priced;
    const recompute = recomputeProductIds(h.c.db, [id], h.clock.now());
    await new Promise((r) => setTimeout(r, 300));
    release();
    await Promise.all([update, recompute]);

    const row = await h.c.db.productPrice.findUniqueOrThrow({ where: { productId: id } });
    expect(row.basePriceMinor).toBe(2_000);
    expect(row.effectivePriceMinor).toBe(1_000);
  });

  it('a product promotion is not lost to a write that resolved its price before the promotion existed', async () => {
    // The writer locks the product row, resolves its price (no promotion yet), and
    // stalls before writing it. The product promotion commits and recomputes inline.
    // Without the row lock the recompute finishes first and the writer then
    // overwrites it at full price; the promotion is already marked synced, so
    // nothing repairs it.
    const cat = await seedCategory(h, 'Accessories');
    const id = await seedProduct(h, cat, 'ACC-1', 1_000);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markResolved!: () => void;
    const resolved = new Promise<void>((r) => (markResolved = r));

    const write = h.c.db.$transaction(
      async (tx) => {
        await lockCategoriesShared(tx, [cat]);
        const p = await tx.product.update({ where: { id }, data: { stockQuantity: 5 } });
        const now = h.clock.now();
        const promos = await loadLivePromotions(tx, { productIds: [id], categoryIds: [cat] }, now);
        const resolution = resolvePrice(p, promos, now);
        markResolved();
        await gate;
        await upsertPrices(tx, [{ productId: id, categoryId: cat, basePriceMinor: p.basePriceMinor, ...resolution }]);
      },
      { timeout: 20_000 },
    );
    await resolved;
    const promo = h.http
      .post('/promotions')
      .send({
        name: '30% off one scarf',
        discountType: 'PERCENTAGE',
        value: 30,
        endsAt: h.clock.iso(24 * HOUR),
        target: { scope: 'PRODUCT', productId: id },
      })
      .then((res) => res);
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [, res] = await Promise.all([write, promo]);
    expect(res.status).toBe(201);

    const row = await h.c.db.productPrice.findUniqueOrThrow({ where: { productId: id } });
    expect(row.effectivePriceMinor).toBe(700);
  });

  it('GET /products/:id cache is invalidated by a category-wide change it never saw (version stamp)', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const id = await seedProduct(h, cat, 'A', 10_000);
    expect(await price(id)).toBe(10_000); // now cached
    expect(await h.c.redis.exists(`pdp:${id}`)).toBe(1);

    await categorySale(cat, 50);
    await h.drainRecomputes();
    expect(await price(id)).toBe(5_000);
  });

  it('listing cache: a version bump retires cached pages of that category only', async () => {
    const acc = await seedCategory(h, 'Accessories');
    const shoes = await seedCategory(h, 'Shoes');
    await seedProduct(h, acc, 'A', 10_000);
    await seedProduct(h, shoes, 'S', 10_000);
    const list = (cat: string) => h.http.get(`/products?categoryId=${cat}`).expect(200);

    expect((await list(acc)).body.items[0].effectivePriceMinor).toBe(10_000);
    const shoesBefore = await h.c.versions.get([shoes]);

    await categorySale(acc, 50);
    await h.drainRecomputes();
    expect((await list(acc)).body.items[0].effectivePriceMinor).toBe(5_000);
    expect(await h.c.versions.get([shoes])).toEqual(shoesBefore);
  });

  it('sale end reverts prices: PDP immediately (validity guard), listing after the sweeper', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const id = await seedProduct(h, cat, 'A', 10_000);
    await categorySale(cat, 50, { endsIn: HOUR });
    await h.drainRecomputes();
    expect(await price(id)).toBe(5_000);

    h.clock.advance(HOUR);
    expect(await price(id)).toBe(10_000); // stale row detected and fixed on read

    await seedProduct(h, cat, 'B', 20_000);
    await h.c.db.$executeRaw`UPDATE product_prices SET effective_price_minor = 1, valid_until = now() - interval '1 second'`;
    await priceSweepFunction({}, h.c, makeContext(30_000));
    const list = await h.http.get(`/products?categoryId=${cat}`).expect(200);
    expect(list.body.items.map((i: { effectivePriceMinor: number }) => i.effectivePriceMinor)).toEqual([10_000, 20_000]);
  });

  it('scheduled sale activates at its start time', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const id = await seedProduct(h, cat, 'A', 10_000);
    const res = await categorySale(cat, 25, { startsIn: 2 * HOUR, endsIn: 5 * HOUR });
    expect(res.body.status).toBe('SCHEDULED');

    // Delayed messages were scheduled at the exact start and end instants.
    const delayed = h.queue.sent.filter((m) => m.opts?.delayMs).map((m) => m.opts!.delayMs);
    expect(delayed).toEqual([2 * HOUR, 5 * HOUR]);

    await h.drainRecomputes();
    expect(await price(id)).toBe(10_000);
    h.clock.advance(2 * HOUR);
    expect(await price(id)).toBe(7_500);
  });

  it('a lost recompute message is re-driven by the sweeper (reconciliation)', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const id = await seedProduct(h, cat, 'A', 10_000);

    h.queue.failSends = true; // broker down right after the promotion commits
    const res = await categorySale(cat, 50);
    h.queue.failSends = false;
    expect(res.status).toBe(202);
    expect(res.body.pricePropagation).toBe('DEFERRED');
    expect(await price(id)).toBe(10_000);

    // Within the grace period the sweeper leaves it alone; after it, it re-drives.
    expect((await priceSweepFunction({}, h.c, makeContext(30_000))).reconciled).toBe(0);
    h.clock.advance(60_000);
    expect((await priceSweepFunction({}, h.c, makeContext(30_000))).reconciled).toBe(1);
    await h.drainRecomputes();
    expect(await price(id)).toBe(5_000);

    // Once applied, it is marked synced and never re-driven again.
    h.clock.advance(60_000);
    expect((await priceSweepFunction({}, h.c, makeContext(30_000))).reconciled).toBe(0);
  });

  it('reconcile keeps re-driving a recompute that failed for good (fresh dedupe key per sweep)', async () => {
    // BullMQ swallows an add whose job id is retained as failed; a per-revision key
    // would mean one dead-lettered recompute blocks every later re-drive.
    const cat = await seedCategory(h, 'Accessories');
    await seedProduct(h, cat, 'A', 10_000);
    h.queue.failSends = true;
    await categorySale(cat, 50);
    h.queue.failSends = false;

    const redrive = async () => {
      h.clock.advance(60_000);
      expect((await priceSweepFunction({}, h.c, makeContext(30_000))).reconciled).toBe(1);
      const msg = h.queue.sent.find((m) => m.queue === 'price-recompute')!;
      h.queue.take('price-recompute'); // recompute exhausts its retries: never applied
      return msg.opts!.dedupeKey;
    };
    const first = await redrive();
    const second = await redrive();
    expect(second).not.toBe(first);
  });

  it('cancelling a sale restores base prices', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const id = await seedProduct(h, cat, 'A', 10_000);
    const promo = (await categorySale(cat, 50)).body;
    await h.drainRecomputes();

    const res = await h.http.post(`/promotions/${promo.id}/cancel`).expect(200);
    expect(res.body.status).toBe('CANCELLED');
    await h.drainRecomputes();
    expect(await price(id)).toBe(10_000);
    await h.http.post(`/promotions/${promo.id}/cancel`).expect(409);
  });
});

describe('promotion conflicts', () => {
  it('rejects overlapping promotions on the same target (DB exclusion constraint)', async () => {
    const cat = await seedCategory(h, 'Accessories');
    expect((await categorySale(cat, 50, { endsIn: 10 * HOUR })).status).toBe(202);

    const overlap = await categorySale(cat, 30, { startsIn: 5 * HOUR, endsIn: 20 * HOUR });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('PROMOTION_OVERLAP');

    // Adjacent window [10h, 20h) does not overlap [0, 10h).
    expect((await categorySale(cat, 30, { startsIn: 10 * HOUR, endsIn: 20 * HOUR })).status).toBe(202);
  });

  it('a cancelled promotion frees its window', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const first = (await categorySale(cat, 50)).body;
    await h.http.post(`/promotions/${first.id}/cancel`).expect(200);
    expect((await categorySale(cat, 30)).status).toBe(202);
  });

  it('draft promotions can be assigned once; overlap is checked at assignment', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const id = await seedProduct(h, cat, 'A', 10_000);
    const draft = await h.http
      .post('/promotions')
      .send({ name: 'draft', discountType: 'FIXED', value: 2_500, endsAt: h.clock.iso(HOUR) })
      .expect(201);
    expect(draft.body.status).toBe('DRAFT');

    const assigned = await h.http
      .post(`/promotions/${draft.body.id}/assign`)
      .send({ scope: 'PRODUCT', productId: id })
      .expect(200);
    expect(assigned.body).toMatchObject({ status: 'ACTIVE', pricePropagation: 'COMPLETED' });
    expect(await price(id)).toBe(7_500);

    await h.http.post(`/promotions/${draft.body.id}/assign`).send({ scope: 'CATEGORY', categoryId: cat }).expect(409);
  });

  it('validates inputs', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const bad = (body: object) => h.http.post('/promotions').send({ name: 'x', discountType: 'PERCENTAGE', ...body });
    expect((await bad({ value: 150, endsAt: h.clock.iso(HOUR) })).status).toBe(400);
    expect((await bad({ value: 10, endsAt: h.clock.iso(-HOUR) })).status).toBe(400);
    expect(
      (await bad({ value: 10, endsAt: h.clock.iso(HOUR), target: { scope: 'CATEGORY', categoryId: crypto.randomUUID() } }))
        .status,
    ).toBe(422);
    expect(cat).toBeDefined();
  });

  it('rejects values that overflow int columns with 400, not 500', async () => {
    const cat = await seedCategory(h, 'Accessories');
    const fixed = await h.http
      .post('/promotions')
      .send({ name: 'x', discountType: 'FIXED', value: 3_000_000_000, endsAt: h.clock.iso(HOUR) });
    expect(fixed.status).toBe(400);
    const product = await h.http
      .post('/products')
      .send({ sku: 'BIG', name: 'x', categoryId: cat, basePriceMinor: 100, stockQuantity: 3_000_000_000 });
    expect(product.status).toBe(400);
  });
});

describe('GET /products listing', () => {
  it('filters by category, sorts by effective price, and keyset-paginates without gaps or duplicates', async () => {
    const acc = await seedCategory(h, 'Accessories');
    const other = await seedCategory(h, 'Other');
    const prices = [5_000, 1_000, 3_000, 3_000, 9_000, 7_000, 2_000];
    for (const [i, p] of prices.entries()) await seedProduct(h, acc, `P${i}`, p);
    await seedProduct(h, other, 'X', 1);
    await categorySale(acc, 50);
    await h.drainRecomputes();

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: { effectivePriceMinor: number }[]; nextCursor: string | null } } = await h.http
        .get('/products')
        .query({ categoryId: acc, sort: 'price_desc', limit: 3, ...(cursor ? { cursor } : {}) })
        .expect(200);
      seen.push(...res.body.items.map((i: { effectivePriceMinor: number }) => i.effectivePriceMinor));
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(seen).toEqual([...prices].sort((a, b) => b - a).map((p) => p / 2));
  });

  it('rejects a malformed cursor', async () => {
    await h.http.get('/products?cursor=garbage').expect(400);
  });
});
