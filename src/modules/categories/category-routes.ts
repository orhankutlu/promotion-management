import { Router } from 'express';
import { z } from 'zod';
import { Db } from '../../infra/db';

const createBody = z.object({ name: z.string().trim().min(1).max(100) });

export function categoryRoutes(db: Db): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    res.json({ items: await db.category.findMany({ orderBy: { name: 'asc' } }) });
  });

  r.post('/', async (req, res) => {
    const { name } = createBody.parse(req.body);
    res.status(201).json(await db.category.create({ data: { name } }));
  });

  return r;
}
