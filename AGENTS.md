# ModaCo — Promotion Management API

## Context
Take-home case study. Deliverables at submission time: repo, DB schema (DDL), `ADR.md`
(architectural defense + trade-offs), and `AI_APPENDIX.md` (Form 5 — AI collaboration log,
2 key prompts, biggest AI mistake caught in Scenario A/B). This file is internal working
guidance for building the solution, not one of the submitted deliverables.

## Stack
- Node.js + Express + TypeScript
- PostgreSQL + Prisma
- Redis (cache-aside layer for hot reads)
- A message queue abstraction for Scenario A (implemented conceptually/cloud-agnostically —
  see below), backed locally by BullMQ or a simple DB-backed queue table so it runs without
  a cloud account

## Domain Model

Model the domain before touching routes/controllers. Core entities:

**Category**
- `id`, `name`
- Flat (no sub-categories) — this is an assumption, flag if wrong

**Product**
- `id`, `sku` (unique), `name`, `categoryId`, `basePrice`, `stockQuantity`, timestamps

**Promotion**
- `id`, `name`, `discountType` (`PERCENTAGE` | `FIXED`), `value`
- `startDate`, `endDate`, `status` (`SCHEDULED` | `ACTIVE` | `EXPIRED` | `CANCELLED`)
- `scope` (`PRODUCT` | `CATEGORY`) + exactly one of `targetProductId` / `targetCategoryId`

**ProductPrice** (read-optimized, precomputed — this is the answer to Scenario B)
- `productId` (PK/FK → Product)
- `basePrice` (denormalized copy, avoids a join on the hot path)
- `effectivePrice`
- `activePromotionId` (nullable — which promotion produced this price, for auditability)
- `updatedAt`
- Indexed on `(categoryId, effectivePrice)` to make "sort by effective price, filter by
  category" cheap — this is *the* index the highly-trafficked endpoints depend on.

**IngestionJob / IngestionJobChunk** (Scenario A bookkeeping)
- Tracks a vendor file upload: status, total rows, chunks dispatched, chunks completed/failed,
  for observability, retries, and idempotency (see below).

## Business Rules & Conflict Resolution

- A product has at most one *active* promotion at any time.
- **Conflict rule (decided): product-specific promotion always wins over a category-level
  promotion.** A `PromotionResolver` service is the single place this logic lives — every
  write path (promotion create/cancel, product create, vendor ingestion) calls it rather than
  duplicating the rule.
- `ProductPrice` rows are *derived state*, never written directly by API handlers — only the
  `PromotionResolver` / recompute jobs touch them. This keeps the precomputed table
  trustworthy.

## Scenario A — Massive Ingestion (500k+ rows, serverless constraints)

Constraints: strict timeout, restricted memory, stateless (dies when the HTTP response ends).
Design (cloud-agnostic — described in service/pattern terms, not tied to a specific vendor's
SDK, per your call):

1. **Upload → dispatch, don't process inline.** The upload endpoint streams the file straight
   to object storage and returns immediately with an `IngestionJob` id. It never parses rows
   itself.
2. **Streaming split, not full load.** A dispatcher reads the file as a stream (never buffers
   500k rows in memory) and slices it into fixed-size chunks (e.g. 500–1000 rows), pushing one
   queue message per chunk. If the dispatcher itself risks approaching the timeout while
   splitting a very large file, it checkpoints its offset and re-triggers itself
   (self-continuation) rather than trying to finish in one invocation — this is the standard
   escape hatch for "stateless + timeout" environments.
3. **Per-chunk, queue-triggered workers do the actual writes.** Each invocation is small enough
   to comfortably finish inside the timeout: it runs every row through `PromotionResolver`
   (the "must pass through dynamic pricing rules before being saved" requirement) and
   **upserts** `Product` + `ProductPrice` in a single batched transaction per chunk.
4. **Idempotency.** Upsert is keyed on `sku`. Each chunk also records its own completion in
   `IngestionJobChunk`, so a retried/redelivered message is a no-op rather than a duplicate
   write — required because queues generally guarantee at-least-once delivery.
5. **Failure isolation.** A chunk that keeps failing goes to a dead-letter queue and is
   surfaced on the `IngestionJob` status instead of blocking or crashing the rest of the file.

## Scenario B — Flash Sales (50k+ products, simultaneous heavy read/write)

Decided approach: **precomputed `ProductPrice` table + Redis cache-aside in front of it.**

- **Product-scoped promotion**: recompute that single `ProductPrice` row synchronously,
  inline in the request — cheap, no async needed.
- **Category-scoped promotion (the 50k-product case)**: don't touch 50k rows inside the HTTP
  request.
  - Mark the `Promotion` row `ACTIVE` immediately (fast control-plane write — this is what
    makes it "instant" from the admin's point of view).
  - Enqueue a background job that recomputes `ProductPrice` for the whole category using
    **set-based batched `UPDATE`s** (not row-by-row ORM loops), so Postgres does the work in
    a handful of statements rather than 50k round-trips.
  - New products created *while the flash sale is active* run through `PromotionResolver` at
    creation time like any product create — so they pick up the active category promotion
    automatically, no polling or special-casing needed.
- **Cache invalidation strategy**: don't try to enumerate and delete individual cache keys for
  50k products. Use a **versioned cache key per category** (e.g. `products:cat:{id}:v{n}`) —
  bumping `v` on any promotion change instantly "invalidates" every cached listing for that
  category in O(1), and old versions simply expire on their own TTL.
- `GET /products/:id` (explicitly called out as highest-traffic) is cached individually by
  product id and invalidated directly when that product's row changes.

## API Surface

- `GET /products` — filter by category, paginate, sort by `effectivePrice` (reads from
  `ProductPrice`, not computed inline); Redis cache-aside, versioned key per category.
- `GET /products/:id` — individually cached, invalidated on that product's price change.
- `POST /products`, `POST /promotions`, `POST /promotions/:id/cancel`,
  `POST /promotions/:id/assign` (product or category target).
- Ingestion: `POST /ingestion/upload` (kicks off `IngestionJob`), `GET /ingestion/:jobId`
  (status/progress).

## Assumptions (flag if any of these are wrong)
- Categories are flat, no nesting.
- Auth/authz is out of scope for the core deliverable (noted as a "next step" in `ADR.md`,
  not implemented).
- Testing: Jest, focused on `PromotionResolver` conflict logic and the ingestion
  idempotency path — not full coverage.
- Local dev doesn't require real cloud infra: object storage/queue are abstracted behind an
  interface so BullMQ + local disk (or equivalent) stand in for them.

## Still open — ask before assuming
- Exact percentage vs fixed-amount rounding rule (e.g. round to nearest kuruş/cent, or floor?).
- Whether `PromotionResolver` needs to handle overlapping *date ranges* for the same product
  (e.g. two category promotions scheduled for future dates) or only "one active at a time" in
  the present-tense sense.
- Pagination style for `GET /products` — offset or cursor-based (cursor is friendlier at this
  scale but changes the API shape).