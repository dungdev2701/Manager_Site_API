import { FastifyInstance } from 'fastify';
import {
  PrismaClient,
  AllocationBatchStatus,
  AllocationItemStatus,
  TrafficType,
  WebsiteStatus,
} from '@prisma/client';
import {
  MySQLExternalRepositories,
  LinkStatusCount,
  EntityRequest,
} from '../repositories/mysql-external';

// ==================== CONFIG ====================

// Reallocation multiplier: allocate 2.5x remaining needed
const REALLOCATION_MULTIPLIER = 2.5;

// Maximum retry count for failed links
const MAX_RETRY_COUNT = 5;

// Traffic threshold: >= 50k is HIGH, < 50k is LOW
const TRAFFIC_THRESHOLD = 50000;

// Maximum allocations per website per day
const MAX_DAILY_ALLOCATIONS = 3;

// ==================== TYPES ====================

interface ReallocationResult {
  requestId: number | string;
  action: 'reallocated' | 'retried' | 'none';
  newLinksCount: number;
  retriedLinksCount: number;
}

// ==================== SERVICE ====================

/**
 * Service xử lý phân bổ bổ sung cho các request đang running
 *
 * Logic:
 * 1. Kiểm tra request đang running
 * 2. Nếu không còn link ở trạng thái new/registering/profiling
 *    VÀ số finish < 110% entity_limit
 *    VÀ chưa hết timeout
 * 3. Thì:
 *    - Ưu tiên 1: Phân bổ thêm website mới (2.5x số còn thiếu)
 *    - Ưu tiên 2: Retry các link fail_registering/fail_profiling
 */
export class ReallocationService {
  private prisma: PrismaClient;
  private mysqlRepo: MySQLExternalRepositories;

  constructor(private fastify: FastifyInstance) {
    this.prisma = fastify.prisma;
    this.mysqlRepo = new MySQLExternalRepositories(fastify.mysql);
  }

  /**
   * Kiểm tra và thực hiện phân bổ bổ sung cho tất cả request đang running
   */
  async checkAndReallocate(): Promise<{
    checked: number;
    reallocated: number;
    retried: number;
  }> {
    const result = {
      checked: 0,
      reallocated: 0,
      retried: 0,
    };

    // Lấy tất cả request đang running
    const runningRequests = await this.mysqlRepo.entityRequest.findRunning();
    result.checked = runningRequests.length;

    if (runningRequests.length === 0) {
      return result;
    }

    // Batch query link counts
    const runningIds = runningRequests.map((r) => r.id);
    const linkCountsMap = await this.mysqlRepo.entityLink.countByStatusBatch(runningIds);

    for (const request of runningRequests) {
      const linkCounts = linkCountsMap.get(String(request.id));
      if (!linkCounts) continue;

      const reallocationResult = await this.checkAndReallocateRequest(request, linkCounts);

      if (reallocationResult.action === 'reallocated') {
        result.reallocated++;
      } else if (reallocationResult.action === 'retried') {
        result.retried++;
      }
    }

    return result;
  }

  /**
   * Kiểm tra và phân bổ bổ sung cho một request
   */
  private async checkAndReallocateRequest(
    request: EntityRequest,
    linkCounts: LinkStatusCount
  ): Promise<ReallocationResult> {
    const requestId = request.id;
    const entityLimit = request.entity_limit;
    const threshold = Math.ceil(entityLimit * 1.1); // 110%

    // Kết quả mặc định
    const result: ReallocationResult = {
      requestId,
      action: 'none',
      newLinksCount: 0,
      retriedLinksCount: 0,
    };

    // Kiểm tra điều kiện cần phân bổ bổ sung:
    // 1. Không còn link đang xử lý (new, registering, profiling)
    const processingCount = linkCounts.new + linkCounts.registering + linkCounts.profiling;
    if (processingCount > 0) {
      return result; // Vẫn còn link đang xử lý, không cần reallocation
    }

    // 2. Số finish < 110% entity_limit
    if (linkCounts.finish >= threshold) {
      return result; // Đã đủ, không cần reallocation
    }

    // 3. Chưa hết timeout
    if (this.mysqlRepo.entityRequest.isRequestTimedOut(request)) {
      return result; // Đã hết giờ, không reallocation
    }

    // Tính số link còn thiếu
    const remaining = threshold - linkCounts.finish;
    const targetNewLinks = Math.ceil(remaining * REALLOCATION_MULTIPLIER);

    // Ưu tiên 1: Phân bổ thêm website mới
    const newLinksCount = await this.allocateMoreWebsites(request, targetNewLinks);

    if (newLinksCount > 0) {
      result.action = 'reallocated';
      result.newLinksCount = newLinksCount;

      this.fastify.log.info(
        `Request ${requestId}: Phân bổ bổ sung ${newLinksCount} websites (cần thêm ${remaining} finish)`
      );

      return result;
    }

    // Ưu tiên 2: Retry các link failed (nếu không còn website để phân bổ)
    const retriedCount = await this.retryFailedLinks(requestId);

    if (retriedCount > 0) {
      result.action = 'retried';
      result.retriedLinksCount = retriedCount;

      this.fastify.log.info(
        `Request ${requestId}: Retry ${retriedCount} failed links (không còn website mới)`
      );
    }

    return result;
  }

  /**
   * Phân bổ thêm website cho request
   */
  private async allocateMoreWebsites(
    request: EntityRequest,
    targetCount: number
  ): Promise<number> {
    const requestId = request.id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Lấy danh sách site đã phân bổ cho request này
    const allocatedSites = await this.mysqlRepo.entityLink.getAllocatedSites(requestId);
    const allocatedSiteSet = new Set(allocatedSites);

    // Lấy website có thể phân bổ (chưa được dùng cho request này)
    const highTrafficTarget = Math.ceil(targetCount * 0.5);
    const lowTrafficTarget = targetCount - highTrafficTarget;

    // Lấy high traffic websites
    const highTrafficWebsites = await this.getAvailableWebsites(
      TrafficType.HIGH,
      highTrafficTarget,
      today,
      allocatedSiteSet
    );

    // Lấy low traffic websites
    const lowTrafficWebsites = await this.getAvailableWebsites(
      TrafficType.LOW,
      lowTrafficTarget,
      today,
      allocatedSiteSet
    );

    const allWebsites = [...highTrafficWebsites, ...lowTrafficWebsites];

    if (allWebsites.length === 0) {
      return 0; // Không còn website để phân bổ
    }

    // Tạo batch mới
    const lastBatch = await this.prisma.allocationBatch.findFirst({
      where: { externalRequestId: String(requestId) },
      orderBy: { batchNumber: 'desc' },
    });
    const batchNumber = (lastBatch?.batchNumber || 0) + 1;

    const batch = await this.prisma.allocationBatch.create({
      data: {
        externalRequestId: String(requestId),
        batchNumber,
        targetCount,
        allocatedCount: allWebsites.length,
        highTrafficCount: highTrafficWebsites.length,
        lowTrafficCount: lowTrafficWebsites.length,
        status: AllocationBatchStatus.COMPLETED,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });

    // Tạo allocation items và update daily allocation
    for (const website of allWebsites) {
      await this.prisma.allocationItem.create({
        data: {
          batchId: batch.id,
          websiteId: website.id,
          domain: website.domain,
          trafficType: website.trafficType,
          status: AllocationItemStatus.PENDING,
        },
      });

      // Update daily allocation count
      await this.prisma.dailyAllocation.upsert({
        where: {
          websiteId_date: { websiteId: website.id, date: today },
        },
        create: {
          websiteId: website.id,
          date: today,
          allocationCount: 1,
        },
        update: {
          allocationCount: { increment: 1 },
        },
      });
    }

    // Insert vào MySQL entity_link
    const links = allWebsites.map((w) => ({
      entityRequestId: requestId,
      email: request.entity_email,
      username: request.username,
      about: request.about,
      site: w.domain,
      accountType: request.account_type,
      trafficType: w.trafficType === TrafficType.HIGH ? 'normal' as const : 'captcha' as const,
    }));

    await this.mysqlRepo.entityLink.insertMany(links);

    return allWebsites.length;
  }

  /**
   * Lấy danh sách website có thể phân bổ
   * Dựa trên traffic từ metrics JSON field
   */
  private async getAvailableWebsites(
    trafficType: TrafficType,
    limit: number,
    today: Date,
    excludeSites: Set<string>
  ): Promise<Array<{ id: string; domain: string; trafficType: TrafficType }>> {
    if (limit <= 0) return [];

    // Query websites có status RUNNING và chưa được dùng
    const websites = await this.prisma.website.findMany({
      where: {
        status: WebsiteStatus.RUNNING,
        deletedAt: null,
        domain: {
          notIn: Array.from(excludeSites),
        },
      },
      select: {
        id: true,
        domain: true,
        metrics: true,
      },
    });

    // Get daily allocations for today
    const dailyAllocations = await this.prisma.dailyAllocation.findMany({
      where: { date: today },
    });
    const allocationMap = new Map(
      dailyAllocations.map((d) => [d.websiteId, d.allocationCount])
    );

    // Filter và phân loại theo traffic
    const available = websites
      .filter((w) => {
        const dailyCount = allocationMap.get(w.id) || 0;
        return dailyCount < MAX_DAILY_ALLOCATIONS;
      })
      .map((w) => {
        const metrics = w.metrics as Record<string, unknown> | null;
        const traffic = (metrics?.traffic as number) || 0;
        const websiteTrafficType = traffic >= TRAFFIC_THRESHOLD ? TrafficType.HIGH : TrafficType.LOW;
        return {
          id: w.id,
          domain: w.domain,
          traffic,
          trafficType: websiteTrafficType,
        };
      })
      .filter((w) => w.trafficType === trafficType)
      .sort((a, b) => b.traffic - a.traffic); // Sort by traffic descending

    return available.slice(0, limit).map((w) => ({
      id: w.id,
      domain: w.domain,
      trafficType: w.trafficType,
    }));
  }

  /**
   * Retry các link failed
   */
  private async retryFailedLinks(requestId: number | string): Promise<number> {
    // Lấy các link có thể retry
    const retryableLinks = await this.mysqlRepo.entityLink.findRetryableLinks(
      requestId,
      MAX_RETRY_COUNT
    );

    if (retryableLinks.length === 0) {
      return 0;
    }

    // Retry tất cả
    const linkIds = retryableLinks.map((l) => l.id);
    return this.mysqlRepo.entityLink.retryFailedLinks(linkIds);
  }

  /**
   * Lấy config hiện tại (để dễ điều chỉnh)
   */
  getConfig() {
    return {
      reallocationMultiplier: REALLOCATION_MULTIPLIER,
      maxRetryCount: MAX_RETRY_COUNT,
      trafficThreshold: TRAFFIC_THRESHOLD,
      maxDailyAllocations: MAX_DAILY_ALLOCATIONS,
    };
  }
}
