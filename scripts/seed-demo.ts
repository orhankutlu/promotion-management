/**
 * Small, realistic dataset so every endpoint has something to show in /docs.
 *   npm run seed:demo
 *
 * Goes through the real services (same paths as the API), then recomputes the sale
 * category directly so prices are right even before the worker has started.
 */
import { loadConfig } from '../src/config';
import { buildContainer } from '../src/container';

const DAY = 24 * 60 * 60 * 1000;

const CATALOG: Record<string, [sku: string, name: string, priceMinor: number, stock: number][]> = {
  Accessories: [
    ['ACC-001', 'Silk scarf', 49_990, 25],
    ['ACC-002', 'Wool beanie', 19_990, 40],
    ['ACC-003', 'Leather gloves', 64_990, 12],
    ['ACC-004', 'Cashmere wrap', 129_990, 6],
    ['ACC-005', 'Sunglasses', 89_990, 18],
    ['ACC-006', 'Canvas belt', 24_990, 50],
    ['ACC-007', 'Silver cufflinks', 74_990, 9],
    ['ACC-008', 'Printed bandana', 9_990, 80],
    ['ACC-009', 'Knit gloves', 14_990, 35],
    ['ACC-010', 'Bucket hat', 29_990, 22],
  ],
  Shoes: [
    ['SHO-001', 'White sneakers', 139_990, 30],
    ['SHO-002', 'Chelsea boots', 249_990, 14],
    ['SHO-003', 'Leather loafers', 189_990, 16],
    ['SHO-004', 'Running shoes', 169_990, 28],
    ['SHO-005', 'Suede desert boots', 209_990, 10],
    ['SHO-006', 'Canvas slip-ons', 79_990, 45],
    ['SHO-007', 'Ankle boots', 229_990, 11],
    ['SHO-008', 'Sandals', 59_990, 60],
    ['SHO-009', 'Oxford shoes', 199_990, 8],
    ['SHO-010', 'Hiking boots', 279_990, 7],
  ],
  Bags: [
    ['BAG-001', 'Leather tote', 299_990, 9],
    ['BAG-002', 'Canvas backpack', 119_990, 20],
    ['BAG-003', 'Crossbody bag', 149_990, 15],
    ['BAG-004', 'Weekender duffel', 349_990, 5],
    ['BAG-005', 'Laptop sleeve', 69_990, 30],
    ['BAG-006', 'Clutch', 99_990, 12],
    ['BAG-007', 'Belt bag', 54_990, 26],
    ['BAG-008', 'Messenger bag', 179_990, 10],
    ['BAG-009', 'Card holder', 29_990, 70],
    ['BAG-010', 'Shopper bag', 44_990, 40],
  ],
};

async function main() {
  const c = buildContainer(loadConfig());
  try {
    if (await c.db.category.count({ where: { name: { in: Object.keys(CATALOG) } } })) {
      console.log('demo data already present; skipping');
      return;
    }
    const now = Date.now();
    const cats: Record<string, string> = {};
    const skus: Record<string, string> = {};
    for (const [name, items] of Object.entries(CATALOG)) {
      cats[name] = (await c.db.category.create({ data: { name } })).id;
      for (const [sku, productName, basePriceMinor, stockQuantity] of items) {
        skus[sku] = (await c.products.create({ sku, name: productName, categoryId: cats[name]!, basePriceMinor, stockQuantity })).id;
      }
    }

    // Live category sale, plus a product promotion inside it (product scope wins).
    await c.promotions.create({
      name: '30% Off All Accessories',
      discountType: 'PERCENTAGE',
      value: 30,
      endsAt: new Date(now + 7 * DAY),
      target: { scope: 'CATEGORY', categoryId: cats.Accessories! },
    });
    await c.promotions.create({
      name: '10% off the silk scarf',
      discountType: 'PERCENTAGE',
      value: 10,
      endsAt: new Date(now + 7 * DAY),
      target: { scope: 'PRODUCT', productId: skus['ACC-001']! },
    });
    // Starts tomorrow: SCHEDULED until then.
    await c.promotions.create({
      name: 'Shoe week: 20% off',
      discountType: 'PERCENTAGE',
      value: 20,
      startsAt: new Date(now + DAY),
      endsAt: new Date(now + 8 * DAY),
      target: { scope: 'CATEGORY', categoryId: cats.Shoes! },
    });
    // Draft to try POST /promotions/{id}/assign on.
    await c.promotions.create({ name: '50.00 off (draft)', discountType: 'FIXED', value: 5_000, endsAt: new Date(now + 7 * DAY) });

    await c.pricing.recomputeCategory(cats.Accessories!);
    console.log(`seeded ${Object.keys(skus).length} products in ${Object.keys(cats).length} categories, 4 promotions`);
  } finally {
    await c.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
