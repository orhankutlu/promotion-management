import express from 'express';
import pinoHttp from 'pino-http';
import { Container } from './container';
import { docsRoutes } from './http/docs';
import { errorHandler } from './http/errors';
import { logger } from './infra/logger';
import { categoryRoutes } from './modules/categories/category-routes';
import { blobUploadRoute, ingestionRoutes } from './modules/ingestion/ingestion-routes';
import { productRoutes } from './modules/products/product-routes';
import { promotionRoutes } from './modules/promotions/promotion-routes';

export function createApp(c: Container): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.NODE_ENV !== 'test') app.use(pinoHttp({ logger }));

  // Mounted before the JSON parser: the upload body is streamed, never buffered.
  app.use('/blob-upload', blobUploadRoute(c.blob));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    await c.db.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  });
  app.use('/categories', categoryRoutes(c.db));
  app.use('/products', productRoutes(c.products));
  app.use('/promotions', promotionRoutes(c.promotions));
  app.use('/ingestion', ingestionRoutes(c.ingestion));
  app.use(docsRoutes(c.config.PUBLIC_BASE_URL));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'route not found' } });
  });
  app.use(errorHandler);
  return app;
}
