-- ModaCo Promotion API — database schema (PostgreSQL 16).
-- The final schema after all of prisma/migrations/ (the source of truth), folded into
-- one file: 20260928000000_init + 20260928160000_ingestion_job_failed.
--
-- Hand-written (not generated) because Prisma cannot express EXCLUDE constraints,
-- partial indexes or CHECK constraints.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "DiscountType"       AS ENUM ('PERCENTAGE', 'FIXED');
CREATE TYPE "PromotionScope"     AS ENUM ('PRODUCT', 'CATEGORY');
CREATE TYPE "IngestionJobStatus" AS ENUM ('AWAITING_UPLOAD', 'DISPATCHING', 'PROCESSING',
                                          'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');
CREATE TYPE "ChunkStatus"        AS ENUM ('PENDING', 'DONE', 'FAILED');

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sku              text        NOT NULL UNIQUE,
  name             text        NOT NULL,
  category_id      uuid        NOT NULL REFERENCES categories(id),
  -- Money is stored as integer minor units (kuruş/cent): no float drift.
  base_price_minor integer     NOT NULL CHECK (base_price_minor >= 0),
  stock_quantity   integer     NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category_id_id_idx ON products (category_id, id);

-- ---------------------------------------------------------------------------
-- Promotions
-- Status (SCHEDULED/ACTIVE/EXPIRED/CANCELLED) is DERIVED from the dates and
-- cancelled_at, never stored — a stored status silently goes stale when a date
-- passes.
-- ---------------------------------------------------------------------------
CREATE TABLE promotions (
  id                 uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text             NOT NULL,
  discount_type      "DiscountType"   NOT NULL,
  -- PERCENTAGE: basis points (5000 = 50%). FIXED: minor units off.
  value              integer          NOT NULL,
  starts_at          timestamptz      NOT NULL,
  ends_at            timestamptz      NOT NULL,
  cancelled_at       timestamptz,
  -- NULL scope = created but not yet assigned (see POST /promotions/:id/assign)
  scope              "PromotionScope",
  target_product_id  uuid             REFERENCES products(id),
  target_category_id uuid             REFERENCES categories(id),
  created_at         timestamptz      NOT NULL DEFAULT now(),
  -- Reconciliation marker (lightweight outbox): every change bumps pricing_rev;
  -- a finished price recompute records the rev it applied. The sweeper re-drives
  -- any promotion where synced < rev, so a lost queue message or a crash between
  -- "promotion committed" and "recompute enqueued" cannot leave prices stale.
  pricing_rev        integer          NOT NULL DEFAULT 1,
  pricing_synced_rev integer          NOT NULL DEFAULT 0,
  pricing_changed_at timestamptz      NOT NULL DEFAULT now(),

  CONSTRAINT promotions_dates_chk CHECK (ends_at > starts_at),
  CONSTRAINT promotions_value_chk CHECK (
    value > 0 AND (discount_type <> 'PERCENTAGE' OR value <= 10000)
  ),
  CONSTRAINT promotions_target_chk CHECK (
       (scope IS NULL       AND target_product_id IS NULL     AND target_category_id IS NULL)
    OR (scope = 'PRODUCT'   AND target_product_id IS NOT NULL AND target_category_id IS NULL)
    OR (scope = 'CATEGORY'  AND target_category_id IS NOT NULL AND target_product_id IS NULL)
  ),
  -- Conflict rule, part 1: two live promotions on the SAME target may not have
  -- overlapping validity windows. Enforced by the database, so concurrent
  -- admin requests cannot race past an application-level check.
  CONSTRAINT promotions_no_overlap_product EXCLUDE USING gist (
    target_product_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (scope = 'PRODUCT' AND cancelled_at IS NULL),
  CONSTRAINT promotions_no_overlap_category EXCLUDE USING gist (
    target_category_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (scope = 'CATEGORY' AND cancelled_at IS NULL)
  -- Conflict rule, part 2 (product-scoped beats category-scoped) is a precedence
  -- rule applied by the resolver, not a constraint.
);
CREATE INDEX promotions_live_product_idx  ON promotions (target_product_id, starts_at)
  WHERE scope = 'PRODUCT' AND cancelled_at IS NULL;
CREATE INDEX promotions_unsynced_idx ON promotions (pricing_changed_at)
  WHERE pricing_synced_rev < pricing_rev;
CREATE INDEX promotions_live_category_idx ON promotions (target_category_id, starts_at)
  WHERE scope = 'CATEGORY' AND cancelled_at IS NULL;

-- ---------------------------------------------------------------------------
-- Precomputed read model (Scenario B). Derived state: only the pricing
-- recompute paths write here, never API handlers directly.
-- ---------------------------------------------------------------------------
CREATE TABLE product_prices (
  product_id            uuid        PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  category_id           uuid        NOT NULL REFERENCES categories(id), -- denormalized for the listing index
  base_price_minor      integer     NOT NULL,
  effective_price_minor integer     NOT NULL,
  promotion_id          uuid        REFERENCES promotions(id),
  -- When this row stops being correct (a promotion ends or another starts).
  -- NULL = correct until some write changes it.
  valid_until           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- THE storefront index: filter by category, keyset-paginate by effective price.
CREATE INDEX product_prices_category_price_idx ON product_prices (category_id, effective_price_minor, product_id);
CREATE INDEX product_prices_price_idx          ON product_prices (effective_price_minor, product_id);
-- Lets the sweeper find rows whose promotion window has started/ended.
CREATE INDEX product_prices_valid_until_idx    ON product_prices (valid_until) WHERE valid_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Ingestion bookkeeping (Scenario A)
-- ---------------------------------------------------------------------------
CREATE TABLE ingestion_jobs (
  id                   uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
  status               "IngestionJobStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',
  blob_key             text                 NOT NULL,
  rows_total           integer              NOT NULL DEFAULT 0,
  rows_ingested        integer              NOT NULL DEFAULT 0,
  rows_rejected        integer              NOT NULL DEFAULT 0,
  chunks_total         integer              NOT NULL DEFAULT 0,
  chunks_done          integer              NOT NULL DEFAULT 0,
  chunks_failed        integer              NOT NULL DEFAULT 0,
  -- Dispatcher checkpoint: resume point on a CSV record boundary. The header is
  -- captured on the first invocation because a resumed read starts mid-file.
  csv_header           text[],
  dispatch_byte_offset bigint               NOT NULL DEFAULT 0,
  dispatch_row_index   integer              NOT NULL DEFAULT 0,
  dispatch_invocations integer              NOT NULL DEFAULT 0,
  dispatch_done        boolean              NOT NULL DEFAULT false,
  -- Why the dispatcher gave up (status FAILED), e.g. an unparseable CSV.
  last_error           text,
  created_at          timestamptz          NOT NULL DEFAULT now(),
  updated_at           timestamptz          NOT NULL DEFAULT now()
);

CREATE TABLE ingestion_chunks (
  job_id      uuid          NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  chunk_index integer       NOT NULL,
  blob_key    text          NOT NULL,
  row_count   integer       NOT NULL,
  status      "ChunkStatus" NOT NULL DEFAULT 'PENDING',
  attempts    integer       NOT NULL DEFAULT 0,
  last_error  text,
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, chunk_index)
);

CREATE TABLE ingestion_row_errors (
  job_id     uuid    NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  sku        text,
  reason     text    NOT NULL,
  PRIMARY KEY (job_id, row_number)
);
