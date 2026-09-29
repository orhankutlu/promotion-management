import { Router } from 'express';
import { z } from 'zod';
import { PromotionService } from './promotion-service';

const target = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('PRODUCT'), productId: z.string().uuid() }),
  z.object({ scope: z.literal('CATEGORY'), categoryId: z.string().uuid() }),
]);

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  discountType: z.enum(['PERCENTAGE', 'FIXED']),
  value: z.number().positive(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date(),
  target: target.optional(),
});

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export function promotionRoutes(service: PromotionService): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const { limit } = listQuery.parse(req.query);
    res.json({ items: await service.list(limit) });
  });

  r.post('/', async (req, res) => {
    const promo = await service.create(createBody.parse(req.body));
    // 202 when category-wide prices are still propagating in the background.
    const async = promo.pricePropagation === 'QUEUED' || promo.pricePropagation === 'DEFERRED';
    res.status(async ? 202 : 201).json(promo);
  });

  r.get('/:id', async (req, res) => {
    res.json(await service.get(idParam.parse(req.params).id));
  });

  r.post('/:id/assign', async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await service.assign(id, target.parse(req.body)));
  });

  r.post('/:id/cancel', async (req, res) => {
    res.json(await service.cancel(idParam.parse(req.params).id));
  });

  return r;
}
