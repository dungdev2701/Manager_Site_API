import { AllocationItemStatus, Prisma, PrismaClient } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

export class AllocationItemRepository {
  constructor(private db: DbClient) {}

  async updateStatus(
    itemId: string,
    data: Prisma.AllocationItemUpdateInput
  ): Promise<void> {
    await this.db.allocationItem.update({
      where: { id: itemId },
      data,
    });
  }

  async markCompletedAtIfNull(itemId: string, completedAt: Date): Promise<number> {
    const result = await this.db.allocationItem.updateMany({
      where: { id: itemId, completedAt: null },
      data: { completedAt },
    });
    return result.count;
  }

  async bulkResetToNewForRecycle(itemIds: string[]): Promise<number> {
    if (itemIds.length === 0) return 0;
    const result = await this.db.allocationItem.updateMany({
      where: {
        id: { in: itemIds },
        status: {
          in: [AllocationItemStatus.FAIL_REGISTERING, AllocationItemStatus.FAIL_PROFILING],
        },
      },
      data: {
        status: AllocationItemStatus.NEW,
        claimedBy: null,
        claimedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    return result.count;
  }
}
