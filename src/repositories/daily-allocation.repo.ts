import { Prisma, PrismaClient } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

export class DailyAllocationRepository {
  constructor(private db: DbClient) {}

  async incrementAttempts(websiteIds: string[], date: Date): Promise<void> {
    if (websiteIds.length === 0) return;
    const dateStr = date.toISOString().split('T')[0];
    await this.db.$executeRaw`
      INSERT INTO daily_allocations (id, "websiteId", date, "allocationCount", "updatedAt")
      SELECT gen_random_uuid(), unnest(${websiteIds}::text[]), ${dateStr}::date, 1, NOW()
      ON CONFLICT ("websiteId", date)
      DO UPDATE SET
        "allocationCount" = daily_allocations."allocationCount" + 1,
        "updatedAt" = NOW()
    `;
  }

  async decrementAllocationCount(websiteId: string, date: Date): Promise<void> {
    await this.db.$executeRaw`
      UPDATE daily_allocations
      SET
        "allocationCount" = GREATEST(0, "allocationCount" - 1),
        "updatedAt" = NOW()
      WHERE
        "websiteId" = ${websiteId}
        AND date = ${date}
    `;
  }

  async incrementTerminalCount(params: {
    websiteId: string;
    date: Date;
    isSuccess: boolean;
  }): Promise<void> {
    const { websiteId, date, isSuccess } = params;
    await this.db.dailyAllocation.upsert({
      where: { websiteId_date: { websiteId, date } },
      create: {
        websiteId,
        date,
        successCount: isSuccess ? 1 : 0,
        failureCount: isSuccess ? 0 : 1,
      },
      update: isSuccess
        ? { successCount: { increment: 1 } }
        : { failureCount: { increment: 1 } },
    });
  }
}
