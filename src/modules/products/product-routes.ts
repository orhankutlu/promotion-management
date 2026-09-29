import { Router } from 'express';
import { z } from 'zod';
import { formatMinor, MAX_INT32 } from '../../domain/money';
import { ProductView } from './product-repo';
import { ProductService } from './product-service';

const listQuery = z.object({
  categoryId: z.string().uuid().optional(),
  sort: z.enum(['price_asc', 'price_desc']).default('price_asc'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

const createBody = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  categoryId: z.string().uuid(),
  basePriceMinor: z.number().int().min(0).max(MAX_INT32),
  stockQuantity: z.number().int().min(0).max(MAX_INT32).default(0),
});

const idParam = z.object({ id: z.string().uuid() });

/** Adds human-readable decimal prices next to the integer minor units. */
export const present = (v: ProductView) => ({
  ...v,
  basePrice: formatMinor(v.basePriceMinor),
  effectivePrice: formatMinor(v.effectivePriceMinor),
});

export function productRoutes(service: ProductService): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const q = listQuery.parse(req.query);
    const page = await service.list({
      categoryId: q.categoryId,
      sort: q.sort === 'price_asc' ? 'asc' : 'desc',
      limit: q.limit,
      cursor: q.cursor,
    });
    res.json({ items: page.items.map(present), nextCursor: page.nextCursor });
  });

  r.get('/:id', async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(present(await service.get(id)));
  });

  r.post('/', async (req, res) => {
    const body = createBody.parse(req.body);
    res.status(201).json(present(await service.create(body)));
  });

  return r;
}
