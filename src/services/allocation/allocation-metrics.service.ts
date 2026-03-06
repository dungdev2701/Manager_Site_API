import { AllocationItemStatus, Prisma, PrismaClient } from '@prisma/client';
import { DailyAllocationRepository } from '../../repositories/daily-allocation.repo';
import { ServiceRequestRepository } from '../../repositories/service-request.repo';
import { isBusinessCancelFromNew } from './allocation-rules';

type DbClient = PrismaClient | Prisma.TransactionClient;

interface RecordTerminalResultParams {
  requestId: string;
  websiteId: string;
  allocatedAt: Date;
  prevStatus: AllocationItemStatus;
  nextStatus: AllocationItemStatus;
  errorCode?: string | null;
  isSuccess: boolean;
}

export class AllocationMetricsService {
  incrementAttempts(
    tx: DbClient,
    websiteIds: string[],
    date: Date
  ): Promise<void> {
    const dailyRepo = new DailyAllocationRepository(tx);
    return dailyRepo.incrementAttempts(websiteIds, date);
  }

  async recordTerminalResult(
    tx: DbClient,
    params: RecordTerminalResultParams
  ): Promise<void> {
    const {
      requestId,
      websiteId,
      allocatedAt,
      prevStatus,
      nextStatus,
      errorCode,
      isSuccess,
    } = params;

    const allocatedDate = new Date(allocatedAt);
    allocatedDate.setHours(0, 0, 0, 0);

    const dailyRepo = new DailyAllocationRepository(tx);
    const requestRepo = new ServiceRequestRepository(tx);

    const businessCancel = isBusinessCancelFromNew(prevStatus, nextStatus, errorCode);
    if (businessCancel) {
      await Promise.all([
        dailyRepo.decrementAllocationCount(websiteId, allocatedDate),
        requestRepo.decrementTotalLinks(requestId, 1),
      ]);
      return;
    }

    await Promise.all([
      requestRepo.incrementResultCounter(requestId, isSuccess),
      dailyRepo.incrementTerminalCount({
        websiteId,
        date: allocatedDate,
        isSuccess,
      }),
    ]);
  }
}
