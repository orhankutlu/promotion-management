-- A dispatcher that exhausts its retries (e.g. malformed CSV) marks the job FAILED
-- with the error, instead of leaving it in DISPATCHING forever.
ALTER TYPE "IngestionJobStatus" ADD VALUE 'FAILED';
ALTER TABLE ingestion_jobs ADD COLUMN last_error text;
