import { defaultPricingPipeline, toDraft } from '../../src/domain/pricing/rules';

const pipeline = defaultPricingPipeline();

function price(row: Record<string, string>) {
  const d = toDraft(row);
  if (!d.ok) return d;
  return pipeline.run(d.draft);
}

const base = { sku: 'SKU-1', name: 'Scarf', category: 'Accessories', stock: '5' };

describe('pricing pipeline', () => {
  it('marks up cost when no list price and charm-rounds up', () => {
    // 100.00 * 1.6 = 160.00 -> 160.99
    const r = price({ ...base, vendor_cost: '100.00' });
    expect(r).toMatchObject({ ok: true, draft: { basePriceMinor: 16_099 } });
  });

  it('uses list price, but raises it to the minimum-margin floor', () => {
    // cost 100, list 105 < floor 115 -> 115.00 -> 115.99
    const r = price({ ...base, vendor_cost: '100', list_price: '105' });
    expect(r).toMatchObject({ ok: true, draft: { basePriceMinor: 11_599 } });
  });

  it('keeps a price that already ends in .99', () => {
    const r = price({ ...base, vendor_cost: '10', list_price: '49.99' });
    expect(r).toMatchObject({ ok: true, draft: { basePriceMinor: 4_999 } });
  });

  it('rejects invalid rows with a reason instead of throwing', () => {
    expect(price({ ...base, vendor_cost: 'abc' })).toEqual({ ok: false, reason: 'validate: invalid vendor_cost' });
    expect(price({ ...base, sku: '', vendor_cost: '1' })).toEqual({ ok: false, reason: 'validate: missing sku' });
    expect(price({ ...base, vendor_cost: '1', stock: '-2' })).toEqual({ ok: false, reason: 'validate: invalid stock' });
  });

  it('rejects absurd prices (vendor unit errors)', () => {
    const r = price({ ...base, vendor_cost: '999999' });
    expect(r.ok).toBe(false);
  });
});
