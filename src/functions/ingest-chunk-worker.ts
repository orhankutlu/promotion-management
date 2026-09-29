import { Prisma } from '@prisma/client';
import { PricingDraft } from '../domain/pricing/pipeline';
import { toDraft } from '../domain/pricing/rules';
import { Db } from '../infra/db';
import { lockCategoriesShared } from '../infra/locks';
import { IngestChunkMessage } from '../infra/queue/queue';
import { ChunkRow } from './ingest-dispatcher';
import { finalizeIfComplete } from './ingest-finalize';
import { FunctionContext, FunctionDeps } from './runtime';

interface RowError {
  rowNumber: number;
  sku: string | null;
  reason: string;
}

/**
 * Processes one chunk (≤ INGEST_CHUNK_SIZE rows) — small enough to finish far inside
 * any serverless timeout.
 *
 *  1. Every row passes through the internal pricing pipeline (validation, markup,
 *     margin floor, charm rounding) and then the shared PromotionResolver.
 *     Invalid rows are recorded, not fatal.
 *  2. ONE transaction does: claim the chunk (PENDING -> DONE), upsert products and
 *     prices in bulk (unnest), record row errors, bump job counters. The claim and
 *     the writes commit or roll back together, so an at-least-once redelivery either
 *     sees DONE and no-ops, or redoes the whole chunk — never half of it.
 *  3. Cache versions for touched categories are bumped after commit.
 *
 * Retries: any throw is retried by the queue with backoff; after the last attempt
 * the message lands in the DLQ handler (onChunkExhausted) and the job reports it.
 */
export async function ingestChunkWorker(
  event: IngestChunkMessage,
  deps: FunctionDeps,
  _ctx: FunctionContext,
): Promise<{ status: 'skipped' | 'done'; ingested: number; rejected: number }> {
  const { db, blob, pricing, versions, pipeline } = deps;
  const where = { jobId_chunkIndex: { jobId: event.jobId, chunkIndex: event.chunkIndex } };
  const chunk = await db.ingestionChunk.findUnique({ where });
  if (!chunk || chunk.status !== 'PENDING') return { status: 'skipped', ingested: 0, rejected: 0 };
  await db.ingestionChunk.update({ where, data: { attempts: { increment: 1 }, updatedAt: new Date() } });

  const rows = JSON.parse((await blob.get(chunk.blobKey)).toString('utf8')) as ChunkRow[];

  // --- 1. pricing pipeline (pure, in memory) ---------------------------------
  const bySku = new Map<string, { rowNumber: number; draft: PricingDraft & { basePriceMinor: number } }>();
  const errors: RowError[] = [];
  for (const { rowNumber, row } of rows) {
    const parsed = toDraft(row);
    const priced = parsed.ok ? pipeline.run(parsed.draft) : parsed;
    if (!priced.ok) {
      errors.push({ rowNumber, sku: row.sku?.trim() || null, reason: priced.reason });
      continue;
    }
    // Same SKU twice in one chunk: last row wins (ON CONFLICT cannot touch a row twice).
    bySku.set(priced.draft.sku, { rowNumber, draft: priced.draft });
  }
  // SKU order: concurrent chunks inserting the same NEW skus wait on them in the same order.
  const valid = [...bySku.values()].map((v) => v.draft).sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

  const categoryIds = await ensureCategories(db, [...new Set(valid.map((d) => d.categoryName))]);

  // --- 2. one transaction ---------------------------------------------------------
  const touched = await db.$transaction(
    async (tx) => {
      const claimed = await tx.$executeRaw(Prisma.sql`
        UPDATE ingestion_chunks SET status = 'DONE', last_error = NULL, updated_at = now()
        WHERE job_id = ${event.jobId}::uuid AND chunk_index = ${event.chunkIndex} AND status = 'PENDING'
      `);
      if (claimed === 0) return null; // a concurrent delivery already committed this chunk

      const skus = valid.map((d) => d.sku);
      // Products moving category also invalidate their old category's caches.
      const previous = await tx.$queryRaw<{ category_id: string }[]>(Prisma.sql`
        SELECT DISTINCT category_id FROM products WHERE sku = ANY(${skus}::text[])
      `);
      const newCategoryIds = valid.map((d) => categoryIds.get(d.categoryName)!);
      const allCategories = new Set([...newCategoryIds, ...previous.map((p) => p.category_id)]);
      await lockCategoriesShared(tx, allCategories);
      // Lock existing rows in id order — the order recomputes take their FOR SHARE locks
      // (pricing/recompute-sql.ts). Letting the upsert lock them in SKU order instead
      // can deadlock against a concurrent flash-sale recompute of the same category.
      await tx.$queryRaw(Prisma.sql`
        SELECT 1 FROM products WHERE sku = ANY(${skus}::text[]) ORDER BY id FOR UPDATE
      `);

      const products =
        valid.length === 0
          ? []
          : await tx.$queryRaw<{ id: string; categoryId: string; basePriceMinor: number }[]>(Prisma.sql`
              INSERT INTO products (sku, name, category_id, base_price_minor, stock_quantity)
              SELECT * FROM unnest(
                ${skus}::text[],
                ${valid.map((d) => d.name)}::text[],
                ${newCategoryIds}::uuid[],
                ${valid.map((d) => d.basePriceMinor)}::int[],
                ${valid.map((d) => d.stockQuantity)}::int[]
              )
              ON CONFLICT (sku) DO UPDATE SET
                name = EXCLUDED.name,
                category_id = EXCLUDED.category_id,
                base_price_minor = EXCLUDED.base_price_minor,
                stock_quantity = EXCLUDED.stock_quantity,
                updated_at = now()
              RETURNING id, category_id AS "categoryId", base_price_minor AS "basePriceMinor"
            `);
      await pricing.priceProductsInTx(tx, products);

      if (errors.length > 0) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO ingestion_row_errors (job_id, row_number, sku, reason)
          SELECT ${event.jobId}::uuid, u.row_number, NULLIF(u.sku, ''), u.reason FROM unnest(
            ${errors.map((e) => e.rowNumber)}::int[],
            ${errors.map((e) => e.sku ?? '')}::text[],
            ${errors.map((e) => e.reason)}::text[]) AS u(row_number, sku, reason)
          ON CONFLICT DO NOTHING
        `);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE ingestion_jobs
        SET chunks_done = chunks_done + 1,
            rows_ingested = rows_ingested + ${rows.length - errors.length},
            rows_rejected = rows_rejected + ${errors.length},
            updated_at = now()
        WHERE id = ${event.jobId}::uuid
      `);
      return allCategories;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );

  if (!touched) return { status: 'skipped', ingested: 0, rejected: 0 };
  await versions.bump(touched);
  await finalizeIfComplete(db, event.jobId);
  return { status: 'done', ingested: rows.length - errors.length, rejected: errors.length };
}

/** DLQ handler: the queue gave up on this chunk after its retries. */
export async function onChunkExhausted(db: Db, event: IngestChunkMessage, error: string): Promise<void> {
  const failed = await db.$executeRaw(Prisma.sql`
    UPDATE ingestion_chunks SET status = 'FAILED', last_error = ${error.slice(0, 2000)}, updated_at = now()
    WHERE job_id = ${event.jobId}::uuid AND chunk_index = ${event.chunkIndex} AND status = 'PENDING'
  `);
  if (failed > 0) {
    await db.$executeRaw(Prisma.sql`
      UPDATE ingestion_jobs SET chunks_failed = chunks_failed + 1, updated_at = now()
      WHERE id = ${event.jobId}::uuid
    `);
    await finalizeIfComplete(db, event.jobId);
  }
}

async function ensureCategories(db: Db, names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  await db.$executeRaw(Prisma.sql`
    INSERT INTO categories (name) SELECT unnest(${names}::text[]) ON CONFLICT (name) DO NOTHING
  `);
  const rows = await db.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
    SELECT id, name FROM categories WHERE name = ANY(${names}::text[])
  `);
  return new Map(rows.map((r) => [r.name, r.id]));
}
