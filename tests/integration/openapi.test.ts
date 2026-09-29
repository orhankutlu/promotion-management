import { randomUUID } from 'node:crypto';
import { createHarness, Harness } from './harness';

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(() => h.close());

describe('API reference', () => {
  it('serves the spec and the Scalar UI', async () => {
    const spec = await h.http.get('/openapi.json').expect(200);
    expect(spec.body.openapi).toBe('3.1.0');
    expect(spec.body.servers[0].url).toBe(h.c.config.PUBLIC_BASE_URL);
    const docs = await h.http.get('/docs').expect(200);
    expect(docs.text).toContain('Scalar.createApiReference');
    await h.http.get('/').expect(302).expect('location', '/docs');
  });

  it('every documented operation is routed (spec cannot drift from the app)', async () => {
    const spec = (await h.http.get('/openapi.json')).body as { paths: Record<string, Record<string, unknown>> };
    const unrouted: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths)) {
      const url = path.replace(/\{[^}]+\}/g, randomUUID());
      for (const method of Object.keys(ops)) {
        const res = await (h.http as unknown as Record<string, (u: string) => Promise<{ status: number; body: any }>>)[
          method
        ]!(url);
        // The app's catch-all answers unknown routes with this exact message.
        if (res.status === 404 && res.body?.error?.message === 'route not found') unrouted.push(`${method} ${path}`);
      }
    }
    expect(unrouted).toEqual([]);
  });
});
