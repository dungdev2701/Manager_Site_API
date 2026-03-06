import { Prisma, PrismaClient, RequestStatus } from '@prisma/client';
import { FastifyBaseLogger } from 'fastify';

interface TimeoutExpiredRequestsDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export class TimeoutExpiredRequestsUseCase {
  constructor(private deps: TimeoutExpiredRequestsDeps) {}

  async execute(
    getRequestCompletionTimePer100: () => Promise<number>,
    calculateRequestTimeout: (entityLimit: number, completionTimePer100: number) => number
  ): Promise<{ timedOut: number; cancelledItems: number }> {
    const { prisma, log } = this.deps;
    const completionTimePer100 = await getRequestCompletionTimePer100();
    let timedOut = 0;
    let cancelledItems = 0;

    const runningRequests = await prisma.serviceRequest.findMany({
      where: {
        status: RequestStatus.RUNNING,
        deletedAt: null,
      },
      select: {
        id: true,
        config: true,
      },
    });

    if (runningRequests.length === 0) {
      return { timedOut: 0, cancelledItems: 0 };
    }

    const requestIds = runningRequests.map((r) => r.id);
    const earliestClaims = await prisma.$queryRaw<
      Array<{ requestId: string; earliestClaimedAt: Date }>
    >`
      SELECT ab."requestId" as "requestId", MIN(ai."claimedAt") as "earliestClaimedAt"
      FROM allocation_items ai
      JOIN allocation_batches ab ON ai."batchId" = ab.id
      WHERE ab."requestId" IN (${Prisma.join(requestIds)})
        AND ai."claimedAt" IS NOT NULL
      GROUP BY ab."requestId"
    `;

    const claimTimeMap = new Map(
      earliestClaims.map((r) => [r.requestId, r.earliestClaimedAt])
    );

    const now = new Date();

    for (const request of runningRequests) {
      const startTime = claimTimeMap.get(request.id);
      if (!startTime) {
        continue;
      }

      const config = request.config as Record<string, unknown> | null;
      const entityLimit = (config?.entityLimit as number) || 100;
      const timeoutMinutes = calculateRequestTimeout(entityLimit, completionTimePer100);
      const timeoutMs = timeoutMinutes * 60 * 1000;

      const elapsedMs = now.getTime() - startTime.getTime();
      if (elapsedMs < timeoutMs) {
        continue;
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const cancelRows = await tx.$queryRaw<Array<{ cancelledCount: bigint }>>`
            WITH targets AS (
              SELECT
                ai.id,
                ai."websiteId",
                DATE(ai."allocatedAt") AS alloc_date,
                ai.status AS prev_status
              FROM allocation_items ai
              INNER JOIN allocation_batches ab ON ab.id = ai."batchId"
              WHERE
                ab."requestId" = ${request.id}
                AND ai.status IN ('NEW', 'REGISTERING', 'PROFILING', 'CONNECTING')
                AND ai."completedAt" IS NULL
            ),
            cancelled AS (
              UPDATE allocation_items ai
              SET
                status = 'CANCEL',
                "errorCode" = 'REQUEST_TIMEOUT',
                "errorMessage" = 'Request timed out after ' || ${timeoutMinutes} || ' minutes',
                "completedAt" = NOW()
              FROM targets t
              WHERE ai.id = t.id
              RETURNING t."websiteId", t.alloc_date, t.prev_status
            ),
            fail_agg AS (
              SELECT "websiteId", alloc_date, COUNT(*)::int AS failed_count
              FROM cancelled
              WHERE prev_status IN ('REGISTERING', 'PROFILING', 'CONNECTING')
              GROUP BY "websiteId", alloc_date
            ),
            updated_daily AS (
              UPDATE daily_allocations da
              SET
                "failureCount" = da."failureCount" + fa.failed_count,
                "updatedAt" = NOW()
              FROM fail_agg fa
              WHERE
                da."websiteId" = fa."websiteId"
                AND da.date = fa.alloc_date
              RETURNING 1
            ),
            failed_total AS (
              SELECT COALESCE(SUM(failed_count), 0)::int AS failed_count
              FROM fail_agg
            ),
            updated_request AS (
              UPDATE service_requests sr
              SET "failedLinks" = sr."failedLinks" + ft.failed_count
              FROM failed_total ft
              WHERE sr.id = ${request.id}
              RETURNING 1
            )
            SELECT COUNT(*)::bigint AS "cancelledCount"
            FROM cancelled
          `;
          const cancelled = Number(cancelRows[0]?.cancelledCount || 0);

          await tx.serviceRequest.update({
            where: { id: request.id },
            data: {
              status: RequestStatus.COMPLETED,
              progressPercent: 100,
            },
          });

          return cancelled;
        });

        timedOut++;
        cancelledItems += result;

        log.warn({
          requestId: request.id,
          entityLimit,
          timeoutMinutes,
          startedAt: startTime.toISOString(),
          elapsedMinutes: Math.round(elapsedMs / 60000),
          cancelledItems: result,
        }, 'Request timed out - marked as COMPLETED and cancelled pending items');

      } catch (error) {
        log.error({ error, requestId: request.id }, 'Failed to timeout request');
      }
    }

    if (timedOut > 0) {
      log.info({ timedOut, cancelledItems }, 'Timed out expired requests');
    }

    return { timedOut, cancelledItems };
  }
}
