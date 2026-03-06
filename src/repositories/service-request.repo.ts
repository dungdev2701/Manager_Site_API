import { Prisma, PrismaClient } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

export class ServiceRequestRepository {
  constructor(private db: DbClient) {}

  async incrementResultCounter(requestId: string, isSuccess: boolean): Promise<void> {
    const incrementField = isSuccess ? 'completedLinks' : 'failedLinks';
    await this.db.serviceRequest.update({
      where: { id: requestId },
      data: { [incrementField]: { increment: 1 } },
    });
  }

  async decrementTotalLinks(requestId: string, amount: number = 1): Promise<void> {
    await this.db.serviceRequest.update({
      where: { id: requestId },
      data: { totalLinks: { decrement: amount } },
    });
  }
}
