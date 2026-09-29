# ModaCo — Promotion Management API

Node.js · Express 5 · TypeScript · PostgreSQL 16 · Redis 7 · BullMQ · Prisma

Internal API for ModaCo's product catalog and promotions, built around two operational
realities: **500k-row vendor files ingested under serverless constraints** (Scenario A)
and **flash sales that reprice 50k+ products while the storefront is under heavy read
load** (Scenario B).

| Deliverable | Where |
|---|---|
| Architecture decisions & trade-offs | [`ADR.md`](ADR.md) |
| AI usage appendix (Form 5) | [`AI_APPENDIX.md`](AI_APPENDIX.md) |
| Database schema (DDL) | [`db/schema.sql`](db/schema.sql) |
| Form 5 AI Appendix | [`Form 5_AI_Appendix.pdf`](Form%205_AI_Appendix.pdf) |

## Measured locally (MacBook, Docker Postgres/Redis)

| Scenario | Result |
|---|---|
| B — create "50% off Accessories" on 50,000 products | API responds in **26 ms** (`202`); all 50k prices propagated in **~1.7 s** (10 set-based batches) |
| B — product added to Accessories during the sale | discounted on its very first read |
| A — ingest 500,000-row / 28 MB vendor CSV | **29 s** end-to-end, 500 chunks, 2,500 invalid rows rejected and reported, dispatcher self-continued across 3 invocations under a 20 s simulated timeout, worker ~40 MB RSS after the run |

## Quick start

Prerequisites: **Node 20+** and **Docker** (running).

```bash
npm run up
```

That one command creates `.env`, installs dependencies, starts Postgres and Redis,
applies migrations, asks whether to seed data (demo / demo + 50k products / none), and
runs the API and the worker in the same terminal. Then open
**http://localhost:3100/docs**: an interactive API reference (Scalar) where every endpoint
can be called from the browser. The demo seed includes a live category sale, a product
promotion that overrides it, a scheduled sale and a draft promotion.

| | |
|---|---|
| `Ctrl+C` | stop the API and worker (data is kept) |
| `npm run down` | stop Postgres and Redis |
| `npm run reset` | delete all data (next `npm run up` asks to seed again) |
| `npm run up -- --seed=demo\|large\|none` | skip the question |

The OpenAPI spec is [`openapi.yaml`](openapi.yaml), also served at `/openapi.json`.

<details>
<summary>Manual setup (what <code>npm run up</code> does)</summary>

```bash
cp .env.example .env
docker compose up -d --wait        # postgres :55432, redis :56379
npm install
npm run migrate                    # applies prisma/migrations (incl. EXCLUDE constraints)
npm run seed:demo                  # optional

npm run dev                        # API on :3100
npm run worker                     # local "serverless" function runner (BullMQ)
```
</details>

Demos (with API + worker running):

```bash
npm run demo:flash-sale            # seeds 50k products in "Flash Sale", runs a 50% sale, times propagation
npm run demo:ingestion             # generates a 500k-row CSV and ingests it
# watch the dispatcher checkpoint and re-invoke itself:
FUNCTION_TIMEOUT_MS=20000 FUNCTION_SAFETY_MARGIN_MS=15000 npm run worker
```

Tests (need the docker services; integration tests use a separate `modaco_test` DB):

```bash
npm test                           # 57 tests: unit + integration
npm run test:unit                  # pure domain tests, no infrastructure
```

## API

Full interactive reference at `/docs` once running. Money is integer minor units (`basePriceMinor: 19990` = 199.90); responses also carry
decimal strings (`basePrice`, `effectivePrice`).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/products?categoryId&sort=price_asc\|price_desc&limit&cursor` | reads the precomputed `product_prices` table; keyset pagination (`nextCursor`); cached per category version |
| `GET` | `/products/:id` | hottest endpoint; cached, stamped with category version + price validity |
| `POST` | `/products` | priced by the resolver in the same transaction |
| `GET/POST` | `/categories` | flat categories |
| `POST` | `/promotions` | `{name, discountType: PERCENTAGE\|FIXED, value, startsAt?, endsAt, target?}` → `201` (product scope, applied inline) or `202` (category scope, propagating) |
| `GET` | `/promotions`, `/promotions/:id` | status is derived: `DRAFT/SCHEDULED/ACTIVE/EXPIRED/CANCELLED` |
| `POST` | `/promotions/:id/assign` | `{scope: PRODUCT, productId}` or `{scope: CATEGORY, categoryId}` — for draft promotions |
| `POST` | `/promotions/:id/cancel` | |
| `POST` | `/ingestion/jobs` | returns a presigned upload URL |
| `POST` | `/ingestion/jobs/:id/start` | stands in for the storage "object created" event |
| `GET` | `/ingestion/jobs/:id` | progress, rejected-row samples, dead-lettered chunks |
| `POST` | `/ingestion/jobs/:id/retry-failed` | re-drives a failed dispatcher and dead-lettered chunks |

`value` is a percent (e.g. `50`, `12.5`) for `PERCENTAGE` and minor units for `FIXED`.
Overlapping live promotions on the same target → `409 PROMOTION_OVERLAP`.

Example:

```bash
curl -X POST localhost:3100/promotions -H 'content-type: application/json' -d '{
  "name": "50% Off All Accessories", "discountType": "PERCENTAGE", "value": 50,
  "endsAt": "2026-10-05T00:00:00Z",
  "target": {"scope": "CATEGORY", "categoryId": "<uuid>"}}'
```

Vendor CSV columns: `sku,name,category,vendor_cost,list_price,stock` (`list_price` optional).

## Layout

```
src/
  domain/          pure logic: money, PromotionResolver, pricing rule pipeline
  pricing/         the only writers of product_prices: set-based SQL recompute, sweeper, reconciliation
  cache/           cache-aside + single-flight, versioned category namespaces
  functions/       stateless, serverless-shaped handlers (dispatcher, chunk worker, recompute, sweep)
  workers/         local-runner: BullMQ -> functions, with a simulated hard timeout
  modules/         HTTP: products, promotions, categories, ingestion
  infra/           db, advisory locks, queue port (+BullMQ), blob store port (+local disk)
prisma/migrations  hand-written SQL (EXCLUDE/CHECK constraints) — source of truth
tests/unit         resolver, money, pricing pipeline
tests/integration  flash sale, conflicts, caching, races, SQL/TS parity, ingestion idempotency
```

## Assumptions

- Categories are flat. Auth is out of scope (see ADR "Next steps").
- Conflicts: two live promotions on the same target may not overlap in time (DB-enforced);
  a product-scoped promotion beats a category-scoped one.
- Rounding: percentage discounts round half-up to the minor unit; prices never go below 0.
- "Internal dynamic pricing rules" for vendor rows are modelled as a pluggable pipeline:
  validation → list price or cost+60% markup → min 15% margin floor → .99 charm rounding →
  sanity cap. Then the active promotion is applied.
