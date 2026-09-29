import { Readable } from 'node:stream';
import { applyDiscount } from '../../src/domain/money';
import { ingestChunkWorker, onChunkExhausted } from '../../src/functions/ingest-chunk-worker';
import { ingestDispatcher, onDispatchExhausted } from '../../src/functions/ingest-dispatcher';
import { FunctionContext, makeContext } from '../../src/functions/runtime';
import { createHarness, Harness, HOUR, seedCategory } from './harness';

let h: Harness;
beforeAll(() => {
  h = createHarness({ INGEST_CHUNK_SIZE: '500' });
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const HEADER = 'sku,name,category,vendor_cost,list_price,stock\n';

/** Vendor CSV with awkward-but-valid content: quoted commas/newlines, UTF-8, bad rows. */
function vendorCsv(rows: number, opts: { badEvery?: number; skuPrefix?: string } = {}): string {
  let out = HEADER;
  for (let i = 1; i <= rows; i++) {
    const sku = `${opts.skuPrefix ?? 'V'}-${String(i).padStart(6, '0')}`;
    const category = i % 2 === 0 ? 'Accessories' : 'Çanta & Cüzdan';
    if (opts.badEvery && i % opts.badEvery === 0) {
      out += `${sku},Broken row,${category},not-a-price,,1\n`;
    } else {
      out += `${sku},"Scarf ${i}, silk\nlimited ""edition""",${category},${(10 + (i % 90)).toFixed(2)},,${i % 50}\n`;
    }
  }
  return out;
}

async function upload(csv: string): Promise<string> {
  const created = await h.http.post('/ingestion/jobs').expect(201);
  const url = new URL(created.body.upload.url);
  await h.http
    .put(`/blob-upload${url.search}`)
    .set('content-type', 'text/csv')
    .send(csv)
    .expect(200);
  await h.http.post(`/ingestion/jobs/${created.body.jobId}/start`).expect(202);
  return created.body.jobId;
}

const status = async (jobId: string) => (await h.http.get(`/ingestion/jobs/${jobId}`).expect(200)).body;

describe('Scenario A — ingestion', () => {
  it('ingests a file end-to-end through the pricing pipeline, recording bad rows', async () => {
    const jobId = await upload(vendorCsv(2_300, { badEvery: 100 }));
    await h.drainIngestion();

    const s = await status(jobId);
    expect(s).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      progressPercent: 100,
      rows: { total: 2_300, ingested: 2_277, rejected: 23 },
      chunks: { total: 5, done: 5, failed: 0 },
    });
    expect(s.sampleRowErrors[0]).toEqual({ row: 100, sku: 'V-000100', reason: 'validate: invalid vendor_cost' });

    expect(await h.c.db.product.count()).toBe(2_277);
    expect(await h.c.db.productPrice.count()).toBe(2_277);
    // Quoted newline + comma survived; price went through markup + charm rounding (11.00 * 1.6 = 17.60 -> 17.99).
    const p = await h.c.db.product.findUniqueOrThrow({ where: { sku: 'V-000001' } });
    expect(p.name).toBe('Scarf 1, silk\nlimited "edition"');
    expect(p.basePriceMinor).toBe(1_799);
  });

  it('dispatcher that runs out of time checkpoints and resumes: every row exactly once', async () => {
    const jobId = await upload(vendorCsv(2_300));
    // Every invocation "starts" with only enough time left for one chunk.
    const tight = (): FunctionContext => makeContext(900); // < safety margin (1000ms)
    const { dispatchInvocations } = await h.drainIngestion({ ctx: tight });

    expect(dispatchInvocations).toBe(5); // 4 continuations after full chunks + the final partial chunk
    const s = await status(jobId);
    expect(s).toMatchObject({ status: 'COMPLETED', rows: { total: 2_300, ingested: 2_300 }, chunks: { total: 5 } });
    expect(await h.c.db.product.count()).toBe(2_300);
  });

  it('redelivered chunk message is a no-op (at-least-once delivery)', async () => {
    const jobId = await upload(vendorCsv(600));
    await h.drainIngestion();
    const before = await h.c.db.product.findMany({ orderBy: { sku: 'asc' } });

    const again = await ingestChunkWorker({ jobId, chunkIndex: 0 }, h.c, makeContext(10_000));
    expect(again.status).toBe('skipped');
    const s = await status(jobId);
    expect(s.chunks.done).toBe(2);
    expect(s.rows.ingested).toBe(600);
    expect(await h.c.db.product.findMany({ orderBy: { sku: 'asc' } })).toEqual(before);
  });

  it('concurrent duplicate deliveries of the same chunk commit exactly once', async () => {
    const jobId = await upload(vendorCsv(400));
    for (const m of h.queue.take('ingest-dispatch')) {
      const { ingestDispatcher } = await import('../../src/functions/ingest-dispatcher');
      await ingestDispatcher(m, h.c, makeContext(60_000));
    }
    const [msg] = h.queue.take('ingest-chunk');
    const results = await Promise.all([1, 2, 3].map(() => ingestChunkWorker(msg!, h.c, makeContext(60_000))));
    expect(results.filter((r) => r.status === 'done')).toHaveLength(1);
    expect((await status(jobId)).rows.ingested).toBe(400);
  });

  it('re-ingesting a file updates products in place (upsert by SKU)', async () => {
    await upload(vendorCsv(300));
    await h.drainIngestion();
    await upload(vendorCsv(300).replace('V-000001,"Scarf 1', 'V-000001,"Renamed'));
    await h.drainIngestion();
    expect(await h.c.db.product.count()).toBe(300);
    expect((await h.c.db.product.findUniqueOrThrow({ where: { sku: 'V-000001' } })).name).toMatch(/^Renamed/);
  });

  it('ingested products pick up an active category flash sale', async () => {
    const cat = await seedCategory(h, 'Accessories');
    await h.http
      .post('/promotions')
      .send({
        name: 'Flash',
        discountType: 'PERCENTAGE',
        value: 50,
        endsAt: h.clock.iso(HOUR),
        target: { scope: 'CATEGORY', categoryId: cat },
      })
      .expect(202);
    await upload(vendorCsv(10));
    await h.drainIngestion();

    const p = await h.c.db.product.findUniqueOrThrow({ where: { sku: 'V-000002' }, include: { price: true } });
    expect(p.categoryId).toBe(cat);
    expect(p.price!.effectivePriceMinor).toBe(applyDiscount(p.basePriceMinor, 'PERCENTAGE', 5000));
    expect(p.price!.promotionId).not.toBeNull();
  });

  it('exhausted chunk is dead-lettered, surfaced on the job, and can be re-driven', async () => {
    const jobId = await upload(vendorCsv(1_000));
    for (const m of h.queue.take('ingest-dispatch')) {
      const { ingestDispatcher } = await import('../../src/functions/ingest-dispatcher');
      await ingestDispatcher(m, h.c, makeContext(60_000));
    }
    const [first, second] = h.queue.take('ingest-chunk');
    await ingestChunkWorker(first!, h.c, makeContext(60_000));
    await onChunkExhausted(h.c.db, second!, 'simulated: database unavailable');

    let s = await status(jobId);
    expect(s).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', chunks: { done: 1, failed: 1 } });
    expect(s.failedChunks[0]).toMatchObject({ chunkIndex: 1, lastError: 'simulated: database unavailable' });

    await h.http.post(`/ingestion/jobs/${jobId}/retry-failed`).expect(202, { requeued: 1 });
    await h.drainIngestion();
    s = await status(jobId);
    expect(s).toMatchObject({ status: 'COMPLETED', chunks: { done: 2, failed: 0 }, rows: { ingested: 1_000 } });
  });

  it('rejects uploads with a bad signature and starting before upload', async () => {
    const created = await h.http.post('/ingestion/jobs').expect(201);
    const url = new URL(created.body.upload.url);
    url.searchParams.set('sig', 'f'.repeat(64));
    await h.http.put(`/blob-upload${url.search}`).send('x').expect(403);
    await h.http.post(`/ingestion/jobs/${created.body.jobId}/start`).expect(409);
  });

  it('a stock value that overflows the int column rejects that row only, not the chunk', async () => {
    const jobId = await upload(`${HEADER}OK-1,Fine,Accessories,10.00,,5\nBIG-1,Huge,Accessories,10.00,,99999999999\n`);
    await h.drainIngestion();
    const s = await status(jobId);
    expect(s).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', rows: { ingested: 1, rejected: 1 }, chunks: { failed: 0 } });
    expect(s.sampleRowErrors[0]).toEqual({ row: 2, sku: 'BIG-1', reason: 'validate: invalid stock' });
  });

  it('an uploaded file cannot be replaced (dispatcher checkpoints are byte offsets into it)', async () => {
    const created = await h.http.post('/ingestion/jobs').expect(201);
    const url = new URL(created.body.upload.url);
    await h.http.put(`/blob-upload${url.search}`).send(vendorCsv(5)).expect(200);
    const again = await h.http.put(`/blob-upload${url.search}`).send(vendorCsv(9)).expect(409);
    expect(again.body.error.code).toBe('ALREADY_UPLOADED');
  });

  it('a dispatcher that exhausts its retries marks the job FAILED and can be re-driven', async () => {
    const jobId = await upload(`${HEADER}OK-1,Fine,Accessories,10.00,,5\nBAD-1,"stray"quote,Accessories,10.00,,5\n`);
    const [msg] = h.queue.take('ingest-dispatch');
    await expect(ingestDispatcher(msg!, h.c, makeContext(60_000))).rejects.toThrow();
    await onDispatchExhausted(h.c.db, msg!, 'simulated: csv parse error');

    const s = await status(jobId);
    expect(s).toMatchObject({ status: 'FAILED', error: 'simulated: csv parse error' });

    await h.http.post(`/ingestion/jobs/${jobId}/retry-failed`).expect(202, { requeued: 1 });
    expect(await status(jobId)).toMatchObject({ status: 'DISPATCHING', error: null });
    expect(h.queue.take('ingest-dispatch')).toEqual([{ jobId }]);
  });

  it('a chunk updating existing products does not deadlock with a concurrent recompute', async () => {
    // Recomputes lock product rows FOR SHARE in id order. Make SKU order the reverse
    // of id order, hold the lower id like a recompute mid-statement, let the chunk
    // start, then have the "recompute" ask for the higher id.
    const cat = await seedCategory(h, 'Accessories');
    const make = async (sku: string) =>
      (await h.http.post('/products').send({ sku, name: sku, categoryId: cat, basePriceMinor: 1_000 }).expect(201)).body
        .id as string;
    const [lo, hi] = [await make('P1'), await make('P2')].sort();
    await h.c.db.product.update({ where: { id: hi! }, data: { sku: 'A-HI' } });
    await h.c.db.product.update({ where: { id: lo! }, data: { sku: 'B-LO' } });

    await upload(`${HEADER}A-HI,Hi,Accessories,10.00,,1\nB-LO,Lo,Accessories,10.00,,1\n`);
    for (const m of h.queue.take('ingest-dispatch')) await ingestDispatcher(m, h.c, makeContext(60_000));
    const [chunk] = h.queue.take('ingest-chunk');

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));
    const recompute = h.c.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM products WHERE id = ${lo}::uuid FOR SHARE`;
        markLocked();
        await gate;
        await tx.$queryRaw`SELECT 1 FROM products WHERE id = ${hi}::uuid FOR SHARE`;
      },
      { timeout: 20_000 },
    );
    await locked;
    const ingest = ingestChunkWorker(chunk!, h.c, makeContext(60_000));
    await new Promise((r) => setTimeout(r, 300));
    release();

    await expect(Promise.all([recompute, ingest])).resolves.toEqual([undefined, expect.objectContaining({ status: 'done' })]);
    expect((await h.c.db.product.findUniqueOrThrow({ where: { id: lo! } })).name).toBe('Lo');
  });

  it('streams large uploads to storage without buffering (smoke: 5MB body)', async () => {
    const created = await h.http.post('/ingestion/jobs').expect(201);
    const url = new URL(created.body.upload.url);
    const body = Readable.from(
      (function* () {
        yield HEADER;
        for (let i = 0; i < 60_000; i++) yield `S${i},Name ${i},Cat,10.00,,1\n`;
      })(),
    );
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = h.http.put(`/blob-upload${url.search}`).set('content-type', 'text/csv');
      body.on('data', (d) => req.write(d));
      body.on('end', () => req.end((err, r) => (err ? reject(err) : resolve(r))));
    });
    expect(res.status).toBe(200);
  });
});
