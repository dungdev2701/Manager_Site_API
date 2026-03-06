import {
  AllocationItemStatus,
  Prisma,
  PrismaClient,
  RequestStatus,
} from '@prisma/client';
import { FastifyBaseLogger } from 'fastify';
import { AllocationMetricsService } from '../allocation-metrics.service';
import { decideCompleteTaskStatus } from '../commands/complete-task.command';
import { isSuccessByProfile, shouldCountOnce } from '../allocation-rules';

interface CompleteTaskDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
  allocationMetrics: AllocationMetricsService;
}

interface CompleteTaskInput {
  success: boolean;
  linkProfile?: string;
  linkPost?: string;
  errorCode?: string;
  errorMessage?: string;
}

export class CompleteTaskUseCase {
  constructor(private deps: CompleteTaskDeps) {}

  async execute(
    itemId: string,
    result: CompleteTaskInput,
    updateRequestProgress: (tx: Prisma.TransactionClient, requestId: string) => Promise<void>
  ): Promise<{ success: boolean; message?: string }> {
    const { prisma, allocationMetrics } = this.deps;

    return prisma.$transaction(async (tx) => {
      const item = await tx.allocationItem.findUnique({
        where: { id: itemId },
        select: {
          id: true,
          status: true,
          completedAt: true,
          allocatedAt: true,
          linkProfile: true,
          websiteId: true,
          batch: {
            select: {
              requestId: true,
              request: {
                select: {
                  status: true,
                  config: true,
                },
              },
            },
          },
        },
      });

      if (!item) {
        return { success: false, message: 'Task not found' };
      }

      const isProcessing =
        item.status === AllocationItemStatus.REGISTERING ||
        item.status === AllocationItemStatus.PROFILING ||
        item.status === AllocationItemStatus.CONNECTING;
      if (!isProcessing) {
        return { success: false, message: `Task is not in processing state (current status: ${item.status})` };
      }

      const hasLinkProfile = isSuccessByProfile(result.linkProfile || item.linkProfile);
      const requestConfig = item.batch?.request?.config as Record<string, unknown> | null;
      const entityConnect = (requestConfig?.entityConnect as string) || 'disable';
      const decision = decideCompleteTaskStatus({
        resultSuccess: result.success,
        hasLinkProfile,
        requestStatus: item.batch?.request?.status as RequestStatus | undefined,
        entityConnect,
      });
      const newStatus = decision.newStatus;
      const now = new Date();

      const isTaskCompleted = decision.isCompletedForMetrics;
      const shouldCountResult = isTaskCompleted && shouldCountOnce(item.completedAt);

      const updatePromises: Promise<unknown>[] = [
        tx.allocationItem.update({
          where: { id: itemId },
          data: {
            status: newStatus,
            linkProfile: result.linkProfile,
            linkPost: result.linkPost,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
            ...(shouldCountResult && { completedAt: now }),
            ...(newStatus === AllocationItemStatus.CONNECTING && { claimedBy: null, claimedAt: null }),
            ...(newStatus === AllocationItemStatus.CONNECT && { claimedBy: null, claimedAt: null }),
            resultSyncedAt: now,
          },
        }),
      ];

      if (item.batch?.requestId && shouldCountResult) {
        updatePromises.push(
          allocationMetrics.recordTerminalResult(tx, {
            requestId: item.batch.requestId,
            websiteId: item.websiteId,
            allocatedAt: item.allocatedAt,
            prevStatus: item.status,
            nextStatus: newStatus,
            errorCode: result.errorCode,
            isSuccess: hasLinkProfile,
          })
        );
      }

      await Promise.all(updatePromises);

      if (item.batch?.requestId && isTaskCompleted) {
        await updateRequestProgress(tx, item.batch.requestId);
      }

      return { success: true };
    }, {
      timeout: 10000,
    });
  }
}
