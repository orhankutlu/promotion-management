import { applyDiscount, DiscountType } from './money';

/**
 * The single place the promotion conflict rule lives.
 *
 * Rules:
 *  1. A promotion applies to a product if it is not cancelled, is assigned, and
 *     targets the product (PRODUCT scope) or the product's category (CATEGORY scope).
 *  2. It is active at `now` iff startsAt <= now < endsAt.
 *  3. Product-scoped beats category-scoped. Two live promotions on the same target
 *     cannot overlap (DB EXCLUDE constraint), so at most one candidate per scope;
 *     the (startsAt, id) tie-break only exists to stay deterministic if that ever
 *     changes.
 *  4. validUntil = the earliest instant the answer could change: the winner's end,
 *     or the start of any other applicable promotion. Conservative on purpose — a
 *     spurious recompute is cheap, a missed one shows a wrong price.
 *
 * Pure function: no I/O, no clock. Mirrored in SQL by src/pricing/recompute-sql.ts.
 */

export type PromotionScope = 'PRODUCT' | 'CATEGORY';

export interface ResolvablePromotion {
  id: string;
  discountType: DiscountType;
  value: number;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  scope: PromotionScope | null;
  targetProductId: string | null;
  targetCategoryId: string | null;
}

export interface ResolvableProduct {
  id: string;
  categoryId: string;
  basePriceMinor: number;
}

export interface PriceResolution {
  effectivePriceMinor: number;
  promotionId: string | null;
  validUntil: Date | null;
}

export function appliesTo(promo: ResolvablePromotion, product: ResolvableProduct): boolean {
  if (promo.cancelledAt !== null || promo.scope === null) return false;
  return promo.scope === 'PRODUCT'
    ? promo.targetProductId === product.id
    : promo.targetCategoryId === product.categoryId;
}

export function isActiveAt(promo: ResolvablePromotion, now: Date): boolean {
  return promo.startsAt.getTime() <= now.getTime() && now.getTime() < promo.endsAt.getTime();
}

function precedence(a: ResolvablePromotion, b: ResolvablePromotion): number {
  const scopeRank = (p: ResolvablePromotion) => (p.scope === 'PRODUCT' ? 0 : 1);
  return (
    scopeRank(a) - scopeRank(b) ||
    a.startsAt.getTime() - b.startsAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function resolvePrice(
  product: ResolvableProduct,
  promotions: readonly ResolvablePromotion[],
  now: Date,
): PriceResolution {
  const applicable = promotions.filter((p) => appliesTo(p, product));
  const winner = applicable.filter((p) => isActiveAt(p, now)).sort(precedence)[0];

  let validUntil: number | null = winner ? winner.endsAt.getTime() : null;
  for (const p of applicable) {
    const start = p.startsAt.getTime();
    if (start > now.getTime() && (validUntil === null || start < validUntil)) validUntil = start;
  }

  return {
    effectivePriceMinor: winner
      ? applyDiscount(product.basePriceMinor, winner.discountType, winner.value)
      : product.basePriceMinor,
    promotionId: winner?.id ?? null,
    validUntil: validUntil === null ? null : new Date(validUntil),
  };
}

export type PromotionStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';

/** Status is derived, never stored — it cannot go stale. */
export function promotionStatus(promo: ResolvablePromotion, now: Date): PromotionStatus {
  if (promo.cancelledAt !== null) return 'CANCELLED';
  if (now.getTime() >= promo.endsAt.getTime()) return 'EXPIRED';
  if (promo.scope === null) return 'DRAFT';
  return now.getTime() < promo.startsAt.getTime() ? 'SCHEDULED' : 'ACTIVE';
}
