-- Add requestId column to allocation_items for direct access (denormalized)
-- This eliminates the need to JOIN through allocation_batches to get requestId

-- Add nullable column first
ALTER TABLE "allocation_items" ADD COLUMN "requestId" TEXT;

-- Backfill existing data from allocation_batches
UPDATE "allocation_items" ai
SET "requestId" = ab."requestId"
FROM "allocation_batches" ab
WHERE ai."batchId" = ab.id;

-- Add foreign key constraint
ALTER TABLE "allocation_items"
ADD CONSTRAINT "allocation_items_requestId_fkey"
FOREIGN KEY ("requestId")
REFERENCES "service_requests"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Add index for fast lookups
CREATE INDEX "allocation_items_requestId_idx" ON "allocation_items"("requestId");
