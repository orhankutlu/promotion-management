import { MAX_INT32, parseDecimalToMinor } from '../money';
import { PricingDraft, PricingPipeline, PricingRule, RuleOutcome, VendorRow } from './pipeline';

const ok = (draft: PricingDraft): RuleOutcome => ({ ok: true, draft });
const reject = (reason: string): RuleOutcome => ({ ok: false, reason });

/** Structural validation happens while mapping the raw CSV record to a draft. */
export function toDraft(row: VendorRow): { ok: true; draft: PricingDraft } | { ok: false; reason: string } {
  const sku = row.sku?.trim();
  const name = row.name?.trim();
  const categoryName = row.category?.trim();
  if (!sku) return { ok: false, reason: 'validate: missing sku' };
  if (sku.length > 64) return { ok: false, reason: 'validate: sku too long' };
  if (!name) return { ok: false, reason: 'validate: missing name' };
  if (!categoryName) return { ok: false, reason: 'validate: missing category' };

  const vendorCostMinor = parseDecimalToMinor(row.vendor_cost ?? '');
  if (vendorCostMinor === null) return { ok: false, reason: 'validate: invalid vendor_cost' };

  const rawList = row.list_price?.trim() ?? '';
  const listPriceMinor = rawList === '' ? null : parseDecimalToMinor(rawList);
  if (rawList !== '' && listPriceMinor === null) return { ok: false, reason: 'validate: invalid list_price' };

  // Digits only ("1e3" / "-1" / "2.5" are vendor errors), and must fit the int column:
  // an out-of-range value would otherwise fail the whole chunk's insert, not just this row.
  const rawStock = row.stock?.trim() || '0';
  const stockQuantity = Number(rawStock);
  if (!/^\d+$/.test(rawStock) || stockQuantity > MAX_INT32) {
    return { ok: false, reason: 'validate: invalid stock' };
  }

  return {
    ok: true,
    draft: { sku, name, categoryName, stockQuantity, vendorCostMinor, listPriceMinor, basePriceMinor: null },
  };
}

/** Use the vendor's list price if given, otherwise cost + standard markup. */
export class ListPriceOrMarkupRule implements PricingRule {
  readonly name = 'markup';
  constructor(private readonly markupBps: number) {}
  apply(d: PricingDraft): RuleOutcome {
    const base = d.listPriceMinor ?? Math.round((d.vendorCostMinor * (10_000 + this.markupBps)) / 10_000);
    return ok({ ...d, basePriceMinor: base });
  }
}

/** Never sell below cost + minimum margin: raise the price to the floor. */
export class MinimumMarginRule implements PricingRule {
  readonly name = 'min-margin';
  constructor(private readonly minMarginBps: number) {}
  apply(d: PricingDraft): RuleOutcome {
    if (d.basePriceMinor === null) return reject('no base price to check');
    const floor = Math.ceil((d.vendorCostMinor * (10_000 + this.minMarginBps)) / 10_000);
    return ok({ ...d, basePriceMinor: Math.max(d.basePriceMinor, floor) });
  }
}

/** Charm pricing: round UP to the next x.99 (never down, so margins hold). */
export class CharmPricingRule implements PricingRule {
  readonly name = 'charm-99';
  apply(d: PricingDraft): RuleOutcome {
    if (d.basePriceMinor === null) return reject('no base price to round');
    const p = d.basePriceMinor;
    const rounded = p % 100 === 99 ? p : Math.floor(p / 100) * 100 + 99;
    return ok({ ...d, basePriceMinor: rounded });
  }
}

/** Guard rail against vendor data errors (e.g. price in the wrong unit). */
export class MaxPriceRule implements PricingRule {
  readonly name = 'max-price';
  constructor(private readonly maxMinor: number) {}
  apply(d: PricingDraft): RuleOutcome {
    if (d.basePriceMinor === null) return reject('no base price');
    return d.basePriceMinor > this.maxMinor ? reject(`price ${d.basePriceMinor} exceeds cap`) : ok(d);
  }
}

export function defaultPricingPipeline(): PricingPipeline {
  return new PricingPipeline([
    new ListPriceOrMarkupRule(6_000), // +60%
    new MinimumMarginRule(1_500), // >= cost +15%
    new CharmPricingRule(),
    new MaxPriceRule(10_000_000), // 100,000.00
  ]);
}
