import { PrismaClient, RequestStatus, ServiceRequest } from '@prisma/client';
import { FastifyBaseLogger } from 'fastify';
import { calculateSupplementDeficit } from '../commands/supplement-requests.command';

interface SupplementRequestsDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export class SupplementRequestsUseCase {
  constructor(private deps: SupplementRequestsDeps) {}

  async execute(params: {
    getAllocationMultiplier: () => Promise<number>;
    getClaimTimeout: () => Promise<number>;
    getCompletionThresholdPercent: () => Promise<number>;
    getCompletionTarget: (entityLimit: number, thresholdPercent: number) => number;
    allocateForRequestOptimized: (
      request: ServiceRequest,
      multiplier: number,
      claimTimeout: number,
      overrideEntityLimit?: number
    ) => Promise<unknown>;
  }): Promise<{
    processed: number;
    skipped: number;
    failed: number;
  }> {
    const { prisma, log } = this.deps;
    const {
      getAllocationMultiplier,
      getClaimTimeout,
      getCompletionThresholdPercent,
      getCompletionTarget,
      allocateForRequestOptimized,
    } = params;

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    const reRunRequests = await prisma.serviceRequest.findMany({
      where: {
        status: RequestStatus.RE_RUN,
        idTool: { not: null },
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    if (reRunRequests.length === 0) {
      return { processed, skipped, failed };
    }

    const [multiplier, claimTimeout, thresholdPercent] = await Promise.all([
      getAllocationMultiplier(),
      getClaimTimeout(),
      getCompletionThresholdPercent(),
    ]);

    for (const request of reRunRequests) {
      try {
        const config = request.config as Record<string, unknown> | null;
        const entityLimit = (config?.entityLimit as number) || 100;
        const completionTarget = getCompletionTarget(entityLimit, thresholdPercent);

        const deficit = calculateSupplementDeficit(completionTarget, request.completedLinks);
        if (deficit <= 0) {
          await prisma.serviceRequest.update({
            where: { id: request.id },
            data: { status: RequestStatus.COMPLETED },
          });
          skipped++;
          log.info(
            { requestId: request.id, completedLinks: request.completedLinks, completionTarget },
            'RE_RUN request already met target, set to COMPLETED'
          );
          continue;
        }

        await allocateForRequestOptimized(request, multiplier, claimTimeout, deficit);

        await prisma.serviceRequest.update({
          where: { id: request.id },
          data: { status: RequestStatus.RE_RUNNING },
        });

        processed++;
        log.info(
          { requestId: request.id, deficit, completedLinks: request.completedLinks, completionTarget },
          `Supplement allocation: ${deficit} items needed`
        );
      } catch (error) {
        log.error(
          { err: error, requestId: request.id },
          'Failed to process supplement request'
        );
        failed++;
      }
    }

    return { processed, skipped, failed };
  }
}
