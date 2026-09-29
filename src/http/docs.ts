import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import { parse } from 'yaml';

/**
 * Serves the hand-written OpenAPI spec (openapi.yaml at the repo root) and a Scalar
 * API reference at /docs. The spec's `servers` is set to this deployment's public URL
 * so "Try it" in the reference calls the running API.
 */
export function docsRoutes(publicBaseUrl: string): Router {
  const spec = { ...parse(readFileSync(join(process.cwd(), 'openapi.yaml'), 'utf8')), servers: [{ url: publicBaseUrl }] };
  const html = `<!doctype html>
<html>
  <head>
    <title>ModaCo API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>Scalar.createApiReference('#app', { url: '/openapi.json' })</script>
  </body>
</html>`;

  const r = Router();
  r.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  r.get('/docs', (_req, res) => {
    res.type('html').send(html);
  });
  r.get('/', (_req, res) => {
    res.redirect('/docs');
  });
  return r;
}
