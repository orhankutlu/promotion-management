/**
 * Generates a synthetic vendor file. Streams to disk (constant memory).
 *   npm run gen:vendor-csv -- --rows 500000 --out .data/vendor-500k.csv
 */
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1]!);
const rows = Number(args.get('rows') ?? 500_000);
const out = args.get('out') ?? `.data/vendor-${rows}.csv`;
const badEvery = Number(args.get('bad-every') ?? 200); // ~0.5% invalid rows
const skuPrefix = args.get('sku-prefix') ?? 'VND';

const categories = ['Accessories', 'Shoes', 'Bags', 'Outerwear', 'Knitwear', 'Denim', 'Jewellery', 'Çanta & Cüzdan'];
const adjectives = ['Silk', 'Leather', 'Wool', 'Linen', 'Cashmere', 'Vintage', 'Classic', 'Oversized'];
const nouns = ['Scarf', 'Belt', 'Loafer', 'Tote', 'Blazer', 'Cardigan', 'Jacket', 'Bracelet'];

async function main() {
  mkdirSync(dirname(out), { recursive: true });
  const ws = createWriteStream(out);
  const write = async (s: string) => {
    if (!ws.write(s)) await once(ws, 'drain');
  };
  await write('sku,name,category,vendor_cost,list_price,stock\n');
  for (let i = 1; i <= rows; i++) {
    const sku = `${skuPrefix}-${String(i).padStart(7, '0')}`;
    const category = categories[i % categories.length]!;
    const name = `${adjectives[i % adjectives.length]} ${nouns[(i >> 3) % nouns.length]} #${i}`;
    if (badEvery > 0 && i % badEvery === 0) {
      await write(`${sku},"${name}",${category},N/A,,3\n`); // unparseable cost -> rejected row
      continue;
    }
    const cost = (5 + ((i * 7919) % 49_500) / 100).toFixed(2);
    const list = i % 3 === 0 ? (Number(cost) * 2.1).toFixed(2) : '';
    // Some names contain commas / quotes to exercise proper CSV quoting.
    const quoted = i % 10 === 0 ? `"${name}, ""limited"""` : `"${name}"`;
    await write(`${sku},${quoted},${category},${cost},${list},${i % 120}\n`);
  }
  ws.end();
  await once(ws, 'finish');
  console.log(`wrote ${rows} rows to ${out}`);
}

void main();
