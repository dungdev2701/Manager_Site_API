import { PrismaClient } from '@prisma/client';
import { FastifyBaseLogger } from 'fastify';

interface ReleaseExpiredClaimsDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export class ReleaseExpiredClaimsUseCase {
  constructor(private deps: ReleaseExpiredClaimsDeps) {}

  async execute(): Promise<number> {
    const { prisma, log } = this.deps;
    const MAX_RETRIES = 1;

    const releasedToNew = await prisma.$executeRaw`
      UPDATE allocation_items
      SET
        status = 'NEW',
        "claimedBy" = NULL,
        "claimedAt" = NULL,
        "retryIndex" = "retryIndex" + 1
      WHERE
        status IN ('REGISTERING', 'PROFILING')
        AND "claimedAt" IS NOT NULL
        AND "claimedAt" + ("claimTimeout" * interval '1 minute') < NOW()
        AND "retryIndex" < ${MAX_RETRIES}
    `;

    const releasedConnecting = await prisma.$executeRaw`
      UPDATE allocation_items
      SET
        "claimedBy" = NULL,
        "claimedAt" = NULL,
        "retryIndex" = "retryIndex" + 1
      WHERE
        status = 'CONNECTING'
        AND "claimedAt" IS NOT NULL
        AND "claimedAt" + ("claimTimeout" * interval '1 minute') < NOW()
        AND "retryIndex" < ${MAX_RETRIES}
    `;

    const markedFailedRows = await prisma.$queryRaw<Array<{ markedCount: bigint }>>`
      WITH targets AS (
        SELECT
          ai.id,
          ai."websiteId",
          DATE(ai."allocatedAt") AS alloc_date,
          ab."requestId"
        FROM allocation_items ai
        INNER JOIN allocation_batches ab ON ab.id = ai."batchId"
        WHERE
          ai.status IN ('REGISTERING', 'PROFILING', 'CONNECTING')
          AND ai."completedAt" IS NULL
          AND ai."claimedAt" IS NOT NULL
          AND ai."claimedAt" + (ai."claimTimeout" * interval '1 minute') < NOW()
          AND ai."retryIndex" >= ${MAX_RETRIES}
      ),
      failed AS (
        UPDATE allocation_items ai
        SET
          status = 'FAILED',
          "errorCode" = 'MAX_RETRIES_EXCEEDED',
          "errorMessage" = 'Task failed after ' || ("retryIndex" + 1) || ' retries (timeout)',
          "completedAt" = NOW()
        FROM targets t
        WHERE ai.id = t.id
        RETURNING t."requestId", t."websiteId", t.alloc_date
      ),
      request_agg AS (
        SELECT "requestId", COUNT(*)::int AS failed_count
        FROM failed
        GROUP BY "requestId"
      ),
      website_agg AS (
        SELECT "websiteId", alloc_date, COUNT(*)::int AS failed_count
        FROM failed
        GROUP BY "websiteId", alloc_date
      ),
      updated_requests AS (
        UPDATE service_requests sr
        SET "failedLinks" = sr."failedLinks" + ra.failed_count
        FROM request_agg ra
        WHERE sr.id = ra."requestId"
        RETURNING 1
      ),
      updated_daily AS (
        UPDATE daily_allocations da
        SET
          "failureCount" = da."failureCount" + wa.failed_count,
          "updatedAt" = NOW()
        FROM website_agg wa
        WHERE
          da."websiteId" = wa."websiteId"
          AND da.date = wa.alloc_date
        RETURNING 1
      )
      SELECT COUNT(*)::bigint AS "markedCount"
      FROM failed
    `;
    const markedFailed = Number(markedFailedRows[0]?.markedCount || 0);

    if (releasedToNew > 0) {
      log.info({ count: releasedToNew }, 'Released expired claims back to NEW (retryIndex incremented)');
    }

    if (releasedConnecting > 0) {
      log.info({ count: releasedConnecting }, 'Released expired CONNECTING claims (claimedBy reset, status kept CONNECTING)');
    }

    if (markedFailed > 0) {
      log.warn({ count: markedFailed }, 'Marked expired claims as FAILED (max retries exceeded)');
    }

    return releasedToNew + releasedConnecting + markedFailed;
  }
}
