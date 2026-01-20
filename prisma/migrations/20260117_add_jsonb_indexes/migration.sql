-- Add functional indexes for JSONB metrics sorting (traffic, DA)
-- These indexes dramatically improve performance when sorting by JSONB fields

-- Index for sorting by traffic (most common sort)
CREATE INDEX IF NOT EXISTS "websites_metrics_traffic_idx"
ON "websites" (COALESCE((metrics->>'traffic')::numeric, 0) DESC);

-- Index for sorting by DA (Domain Authority)
CREATE INDEX IF NOT EXISTS "websites_metrics_da_idx"
ON "websites" (COALESCE((metrics->>'DA')::numeric, 0) DESC);

-- Composite index for filtering by deletedAt + sorting by traffic
CREATE INDEX IF NOT EXISTS "websites_deleted_traffic_idx"
ON "websites" (COALESCE((metrics->>'traffic')::numeric, 0) DESC)
WHERE "deletedAt" IS NULL;

-- Composite index for filtering by deletedAt + sorting by DA
CREATE INDEX IF NOT EXISTS "websites_deleted_da_idx"
ON "websites" (COALESCE((metrics->>'DA')::numeric, 0) DESC)
WHERE "deletedAt" IS NULL;
