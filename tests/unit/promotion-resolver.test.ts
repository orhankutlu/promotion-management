import {
  promotionStatus,
  resolvePrice,
  ResolvablePromotion,
  ResolvableProduct,
} from '../../src/domain/promotion-resolver';

const t = (iso: string) => new Date(`2026-10-01T${iso}:00Z`);
const NOW = t('12:00');

const product: ResolvableProduct = { id: 'p1', categoryId: 'accessories', basePriceMinor: 10_000 };

function promo(overrides: Partial<ResolvablePromotion>): ResolvablePromotion {
  return {
    id: 'x',
    discountType: 'PERCENTAGE',
    value: 5000,
    startsAt: t('00:00'),
    endsAt: t('23:00'),
    cancelledAt: null,
    scope: 'CATEGORY',
    targetProductId: null,
    targetCategoryId: 'accessories',
    ...overrides,
  };
}

describe('resolvePrice', () => {
  it('returns base price when nothing applies', () => {
    expect(resolvePrice(product, [], NOW)).toEqual({
      effectivePriceMinor: 10_000,
      promotionId: null,
      validUntil: null,
    });
  });

  it('applies an active category promotion (flash sale)', () => {
    const r = resolvePrice(product, [promo({ id: 'flash' })], NOW);
    expect(r).toEqual({ effectivePriceMinor: 5_000, promotionId: 'flash', validUntil: t('23:00') });
  });

  it('product-scoped promotion beats category-scoped even if the category one is deeper', () => {
    const r = resolvePrice(
      product,
      [
        promo({ id: 'cat', value: 7000 }),
        promo({ id: 'prod', scope: 'PRODUCT', targetProductId: 'p1', targetCategoryId: null, value: 1000 }),
      ],
      NOW,
    );
    expect(r.promotionId).toBe('prod');
    expect(r.effectivePriceMinor).toBe(9_000);
  });

  it('falls back to the category promotion once the product promotion ends', () => {
    const promos = [
      promo({ id: 'cat' }),
      promo({ id: 'prod', scope: 'PRODUCT', targetProductId: 'p1', targetCategoryId: null, endsAt: t('14:00') }),
    ];
    expect(resolvePrice(product, promos, NOW).validUntil).toEqual(t('14:00'));
    expect(resolvePrice(product, promos, t('14:00')).promotionId).toBe('cat');
  });

  it('ignores cancelled, unassigned, expired and other-target promotions', () => {
    const r = resolvePrice(
      product,
      [
        promo({ id: 'cancelled', cancelledAt: t('10:00') }),
        promo({ id: 'draft', scope: null, targetCategoryId: null }),
        promo({ id: 'expired', startsAt: t('01:00'), endsAt: t('02:00') }),
        promo({ id: 'other-cat', targetCategoryId: 'shoes' }),
        promo({ id: 'other-prod', scope: 'PRODUCT', targetProductId: 'p2', targetCategoryId: null }),
      ],
      NOW,
    );
    expect(r.promotionId).toBeNull();
    expect(r.effectivePriceMinor).toBe(10_000);
  });

  it('end is exclusive, start is inclusive', () => {
    const p = promo({ id: 'w', startsAt: t('12:00'), endsAt: t('13:00') });
    expect(resolvePrice(product, [p], t('12:00')).promotionId).toBe('w');
    expect(resolvePrice(product, [p], t('13:00')).promotionId).toBeNull();
  });

  it('validUntil points at the start of a scheduled promotion so it activates on time', () => {
    const r = resolvePrice(product, [promo({ id: 'later', startsAt: t('18:00') })], NOW);
    expect(r.promotionId).toBeNull();
    expect(r.validUntil).toEqual(t('18:00'));
  });

  it('validUntil is the earliest upcoming change', () => {
    const r = resolvePrice(
      product,
      [
        promo({ id: 'cat', endsAt: t('20:00') }),
        promo({ id: 'soon', scope: 'PRODUCT', targetProductId: 'p1', targetCategoryId: null, startsAt: t('15:00') }),
      ],
      NOW,
    );
    expect(r.promotionId).toBe('cat');
    expect(r.validUntil).toEqual(t('15:00'));
  });

  it('fixed discount never produces a negative price', () => {
    const r = resolvePrice(product, [promo({ discountType: 'FIXED', value: 50_000 })], NOW);
    expect(r.effectivePriceMinor).toBe(0);
  });
});

describe('promotionStatus', () => {
  it('derives status from dates and cancellation', () => {
    expect(promotionStatus(promo({ startsAt: t('13:00') }), NOW)).toBe('SCHEDULED');
    expect(promotionStatus(promo({}), NOW)).toBe('ACTIVE');
    expect(promotionStatus(promo({ endsAt: t('12:00') }), NOW)).toBe('EXPIRED');
    expect(promotionStatus(promo({ cancelledAt: t('11:00') }), NOW)).toBe('CANCELLED');
    expect(promotionStatus(promo({ scope: null, targetCategoryId: null }), NOW)).toBe('DRAFT');
  });
});
