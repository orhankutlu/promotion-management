import { Promotion } from '@prisma/client';
import { bpsToPercent, MAX_INT32, percentToBps } from '../../domain/money';
import { promotionStatus } from '../../domain/promotion-resolver';
import { Db } from '../../infra/db';
import { conflict, HttpError, notFound } from '../../http/errors';
import { Clock, PricingService, Propagation } from '../../pricing/pricing-service';

export type Target = { scope: 'PRODUCT'; productId: string } | { scope: 'CATEGORY'; categoryId: string };

export interface CreatePromotionInput {
  name: string;
  discountType: 'PERCENTAGE' | 'FIXED';
  /** PERCENTAGE: percent (e.g. 50 or 12.5). FIXED: minor units off. */
  value: number;
  startsAt?: Date;
  endsAt: Date;
  target?: Target;
}

export class PromotionService {
  constructor(
    private readonly db: Db,
    private readonly pricing: PricingService,
    private readonly clock: Clock,
  ) {}

  /**
   * Control-plane write only: insert the row (the DB rejects overlaps), return.
   * Category-wide price propagation happens in a worker — the admin gets a response
   * in milliseconds whether the category has 5 products or 50,000.
   */
  async create(input: CreatePromotionInput) {
    const now = this.clock.now();
    const startsAt = input.startsAt ?? now;
    if (input.endsAt <= startsAt) throw new HttpError(400, 'INVALID_DATES', 'endsAt must be after startsAt');
    if (input.endsAt <= now) throw new HttpError(400, 'INVALID_DATES', 'endsAt must be in the future');

    let value: number;
    if (input.discountType === 'PERCENTAGE') {
      if (!(input.value > 0 && input.value <= 100)) throw new HttpError(400, 'INVALID_VALUE', 'percentage must be in (0, 100]');
      try {
        value = percentToBps(input.value);
      } catch {
        throw new HttpError(400, 'INVALID_VALUE', 'percentage supports at most 2 decimals');
      }
    } else {
      if (!Number.isInteger(input.value) || input.value <= 0 || input.value > MAX_INT32) {
        throw new HttpError(400, 'INVALID_VALUE', 'fixed discount must be a positive integer (minor units) within range');
      }
      value = input.value;
    }
    if (input.target) await this.assertTargetExists(input.target);

    const promo = await this.db.promotion.create({
      data: {
        name: input.name,
        discountType: input.discountType,
        value,
        startsAt,
        endsAt: input.endsAt,
        pricingChangedAt: now,
        ...targetColumns(input.target),
      },
    });
    const propagation = await this.pricing.onPromotionChanged(promo);
    return this.present(promo, propagation);
  }

  async assign(id: string, target: Target) {
    await this.assertTargetExists(target);
    const existing = await this.db.promotion.findUnique({ where: { id } });
    if (!existing) throw notFound('promotion');
    const status = promotionStatus(existing, this.clock.now());
    if (status !== 'DRAFT') {
      throw conflict('NOT_ASSIGNABLE', `only unassigned promotions can be assigned (status: ${status})`);
    }
    // Guarded update: a concurrent assign/cancel cannot be overwritten.
    const { count } = await this.db.promotion.updateMany({
      where: { id, scope: null, cancelledAt: null },
      data: { ...targetColumns(target), pricingRev: { increment: 1 }, pricingChangedAt: this.clock.now() },
    });
    if (count === 0) throw conflict('NOT_ASSIGNABLE', 'promotion was modified concurrently');
    const promo = (await this.db.promotion.findUnique({ where: { id } }))!;
    return this.present(promo, await this.pricing.onPromotionChanged(promo));
  }

  async cancel(id: string) {
    const now = this.clock.now();
    const { count } = await this.db.promotion.updateMany({
      where: { id, cancelledAt: null, endsAt: { gt: now } },
      data: { cancelledAt: now, pricingRev: { increment: 1 }, pricingChangedAt: now },
    });
    const promo = await this.db.promotion.findUnique({ where: { id } });
    if (!promo) throw notFound('promotion');
    if (count === 0) {
      throw conflict('NOT_CANCELLABLE', `promotion is already ${promotionStatus(promo, now).toLowerCase()}`);
    }
    return this.present(promo, await this.pricing.onPromotionChanged(promo));
  }

  async get(id: string) {
    const promo = await this.db.promotion.findUnique({ where: { id } });
    if (!promo) throw notFound('promotion');
    return this.present(promo);
  }

  async list(limit: number) {
    const rows = await this.db.promotion.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((p) => this.present(p));
  }

  private async assertTargetExists(target: Target): Promise<void> {
    const exists =
      target.scope === 'PRODUCT'
        ? await this.db.product.count({ where: { id: target.productId } })
        : await this.db.category.count({ where: { id: target.categoryId } });
    if (!exists) throw new HttpError(422, 'INVALID_REFERENCE', `target ${target.scope.toLowerCase()} does not exist`);
  }

  private present(p: Promotion, pricePropagation?: Propagation) {
    return {
      id: p.id,
      name: p.name,
      discountType: p.discountType,
      value: p.discountType === 'PERCENTAGE' ? bpsToPercent(p.value) : p.value,
      startsAt: p.startsAt.toISOString(),
      endsAt: p.endsAt.toISOString(),
      cancelledAt: p.cancelledAt?.toISOString() ?? null,
      status: promotionStatus(p, this.clock.now()),
      target:
        p.scope === 'PRODUCT'
          ? { scope: p.scope, productId: p.targetProductId }
          : p.scope === 'CATEGORY'
            ? { scope: p.scope, categoryId: p.targetCategoryId }
            : null,
      ...(pricePropagation ? { pricePropagation } : {}),
    };
  }
}

function targetColumns(target?: Target) {
  if (!target) return {};
  return target.scope === 'PRODUCT'
    ? { scope: 'PRODUCT' as const, targetProductId: target.productId }
    : { scope: 'CATEGORY' as const, targetCategoryId: target.categoryId };
}
