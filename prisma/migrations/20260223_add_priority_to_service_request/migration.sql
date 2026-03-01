-- CreateEnum
CREATE TYPE "RequestPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- AlterTable
ALTER TABLE "service_requests" ADD COLUMN "priority" "RequestPriority" NOT NULL DEFAULT 'NORMAL';

-- CreateIndex
CREATE INDEX "service_requests_priority_status_idx" ON "service_requests"("priority", "status");
