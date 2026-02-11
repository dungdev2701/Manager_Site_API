-- Add indexes for allocation performance optimization
-- These indexes significantly improve query performance for high-load scenarios

-- ==================== ALLOCATION ITEMS ====================

-- Index for finding PENDING items (most common query for tool claim)
CREATE INDEX IF NOT EXISTS "allocation_items_status_priority_idx"
ON "allocation_items" (status, "priorityScore" DESC, "allocatedAt" ASC)
WHERE status = 'PENDING';

-- Index for finding CLAIMED items by claimedAt (for expired claims release)
CREATE INDEX IF NOT EXISTS "allocation_items_claimed_timeout_idx"
ON "allocation_items" ("claimedAt", "claimTimeout")
WHERE status = 'CLAIMED' AND "claimedAt" IS NOT NULL;

-- Index for batch lookup
CREATE INDEX IF NOT EXISTS "allocation_items_batch_id_idx"
ON "allocation_items" ("batchId");

-- ==================== ALLOCATION BATCHES ====================

-- Index for finding batches by request
CREATE INDEX IF NOT EXISTS "allocation_batches_request_id_idx"
ON "allocation_batches" ("requestId");

-- Index for finding latest batch number
CREATE INDEX IF NOT EXISTS "allocation_batches_request_batch_idx"
ON "allocation_batches" ("requestId", "batchNumber" DESC);

-- ==================== SERVICE REQUESTS ====================

-- Index for finding NEW requests (monitor trigger)
CREATE INDEX IF NOT EXISTS "service_requests_status_created_idx"
ON "service_requests" (status, "createdAt" ASC)
WHERE "deletedAt" IS NULL;

-- Index for finding PENDING/RUNNING requests
CREATE INDEX IF NOT EXISTS "service_requests_active_status_idx"
ON "service_requests" (status)
WHERE status IN ('PENDING', 'RUNNING') AND "deletedAt" IS NULL;

-- Index for idTool lookup
CREATE INDEX IF NOT EXISTS "service_requests_id_tool_idx"
ON "service_requests" ("idTool")
WHERE "idTool" IS NOT NULL AND "deletedAt" IS NULL;

-- ==================== DAILY ALLOCATIONS ====================

-- Index for daily allocation lookup (already has unique constraint)
-- Additional index for date-based aggregation
CREATE INDEX IF NOT EXISTS "daily_allocations_date_idx"
ON "daily_allocations" (date DESC);

-- ==================== WEBSITE STATS ====================

-- Index for getting latest stats by website
CREATE INDEX IF NOT EXISTS "website_stats_website_period_idx"
ON "website_stats" ("websiteId", "periodType", "periodStart" DESC);

-- ==================== SYSTEM CONFIG ====================

-- Key is already unique, no additional index needed

-- ==================== WEBSITES ====================

-- Index for finding RUNNING websites (partial index)
CREATE INDEX IF NOT EXISTS "websites_running_idx"
ON "websites" (status)
WHERE status = 'RUNNING' AND "deletedAt" IS NULL;
