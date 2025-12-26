/*
  Warnings:

  - You are about to drop the column `note` on the `websites` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "websites" DROP COLUMN "note",
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "notes" TEXT;

-- CreateIndex
CREATE INDEX "websites_createdBy_idx" ON "websites"("createdBy");

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
