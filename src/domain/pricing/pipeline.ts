/**
 * Internal dynamic pricing rules that every vendor row must pass through before it
 * is saved (Scenario A). A pipeline is an ordered list of rules; each rule either
 * transforms the draft or rejects the row with a reason. Rejected rows are recorded
 * per job — they never fail the whole chunk.
 *
 * Promotion resolution is deliberately NOT a rule here: it runs after the pipeline
 * through the shared PromotionResolver so every write path uses the same logic.
 */

export interface VendorRow {
  sku?: string;
  name?: string;
  category?: string;
  vendor_cost?: string;
  list_price?: string;
  stock?: string;
}

export interface PricingDraft {
  sku: string;
  name: string;
  categoryName: string;
  stockQuantity: number;
  vendorCostMinor: number;
  listPriceMinor: number | null;
  /** Set by the pipeline; the price the product will be sold at before promotions. */
  basePriceMinor: number | null;
}

export type RuleOutcome = { ok: true; draft: PricingDraft } | { ok: false; reason: string };

export interface PricingRule {
  readonly name: string;
  apply(draft: PricingDraft): RuleOutcome;
}

export type PipelineResult =
  | { ok: true; draft: PricingDraft & { basePriceMinor: number } }
  | { ok: false; reason: string };

export class PricingPipeline {
  constructor(private readonly rules: readonly PricingRule[]) {}

  run(initial: PricingDraft): PipelineResult {
    let draft = initial;
    for (const rule of this.rules) {
      const out = rule.apply(draft);
      if (!out.ok) return { ok: false, reason: `${rule.name}: ${out.reason}` };
      draft = out.draft;
    }
    if (draft.basePriceMinor === null) {
      return { ok: false, reason: 'pipeline: no rule produced a base price' };
    }
    return { ok: true, draft: { ...draft, basePriceMinor: draft.basePriceMinor } };
  }
}
