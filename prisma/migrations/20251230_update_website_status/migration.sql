-- Step 1: Add new enum values to WebsiteStatus
ALTER TYPE "WebsiteStatus" ADD VALUE IF NOT EXISTS 'NEW';
ALTER TYPE "WebsiteStatus" ADD VALUE IF NOT EXISTS 'CHECKING';
ALTER TYPE "WebsiteStatus" ADD VALUE IF NOT EXISTS 'HANDING';
