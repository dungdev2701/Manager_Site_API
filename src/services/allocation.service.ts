import { FastifyInstance } from 'fastify';
import { PrismaClient, WebsiteStatus, AllocationBatchStatus, AllocationItemStatus, TrafficType, AlertType, AlertSeverity, Prisma } from '@prisma/client';
import {
  MySQLExternalRepositories,
  ToolPair,
} from '../repositories/mysql-external';

// ==================== TYPES ====================

interface WebsiteForAllocation {
  id: string;
  domain: string;
  traffic: number;
  successRate: number;
}

interface AllocationResult {
  batchId: string;
  externalRequestId: string;
  allocatedCount: number;
  highTrafficCount: number;
  lowTrafficCount: number;
  websites: Array<{
    websiteId: string;
    domain: string;
    trafficType: TrafficType;
  }>;
}

// Traffic threshold: >= 50k is HIGH, < 50k is LOW
const TRAFFIC_THRESHOLD = 50000;

// Maximum allocations per website per day
const MAX_DAILY_ALLOCATIONS = 3;

// Allocation multiplier: allocate 2.5x entity_limit for buffer
const ALLOCATION_MULTIPLIER = 2.5;

// ==================== SERVICE ====================

export class AllocationService {
  private prisma: PrismaClient;
  private mysqlRepo: MySQLExternalRepositories;

  constructor(private fastify: FastifyInstance) {
    this.prisma = fastify.prisma;
    this.mysqlRepo = new MySQLExternalRepositories(fastify.mysql);
  }

  // ==================== MAIN ALLOCATION FLOW ====================

  /**
   * Process pending requests from MySQL
   * 1. Poll EntityRequest where status='pending' and id_tool=''
   * 2. Find available tool pair (not being used by any running request)
   * 3. Assign tool to request (one tool pair per request at a time)
   * 4. Allocate websites
   * 5. Insert into EntityLink
   *
   * NOTE: Each tool pair can only be assigned to ONE request at a time.
   * When a request is running, its tool pair is locked.
   * Only when the request completes, the tool pair becomes available again.
   */
  async processPendingRequests(): Promise<{
    processed: number;
    skipped: number;
    failed: number;
  }> {
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    // 1. Get pending requests without tool
    const pendingRequests = await this.mysqlRepo.entityRequest.findPendingWithoutTool();

    if (pendingRequests.length === 0) {
      return { processed, skipped, failed };
    }

    // 2. Process each request - find available tool pair for each
    for (const request of pendingRequests) {
      try {
        // Find available tool pair (not used by any running request)
        const toolPair = await this.mysqlRepo.tools.findAvailablePair();

        if (!toolPair) {
          skipped++;
          continue; // Skip this request, try next one
        }

        await this.processRequest(request.id, request.entity_limit, toolPair, {
          email: request.entity_email,
          username: request.username,
          about: request.about,
          accountType: request.account_type,
        });
        processed++;

      } catch (error) {
        this.fastify.log.error({ err: error }, `Failed to process request ${request.id}`);
        await this.createAlert({
          type: AlertType.ALLOCATION_FAILED,
          severity: AlertSeverity.ERROR,
          title: 'Allocation Failed',
          message: `Failed to allocate websites for request ${request.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          entityType: 'EntityRequest',
          entityId: String(request.id),
        });
        failed++;
      }
    }

    // Create alert if all requests were skipped due to no tools
    if (skipped > 0 && processed === 0) {
      await this.createAlert({
        type: AlertType.NO_AVAILABLE_TOOLS,
        severity: AlertSeverity.WARNING,
        title: 'No Available Tools',
        message: `${skipped} pending requests skipped - all tool pairs are busy with running requests`,
      });
    }

    return { processed, skipped, failed };
  }

  /**
   * Process a single request
   */
  async processRequest(
    requestId: number | string,
    entityLimit: number,
    toolPair: ToolPair,
    requestData: {
      email: string;
      username: string;
      about: string | null;
      accountType: string;
    }
  ): Promise<AllocationResult> {

    // Calculate how many websites to allocate (add buffer for failures)
    // If entityLimit = 100, we allocate ~250 websites (2.5x for buffer)
    const targetCount = Math.ceil(entityLimit * ALLOCATION_MULTIPLIER);
    const highTrafficTarget = Math.ceil(targetCount * 0.5);
    const lowTrafficTarget = targetCount - highTrafficTarget;

    // 1. Update request with tool assignment
    await this.mysqlRepo.entityRequest.updateTool(requestId, toolPair.combined, 'running');

    // 2. Get next batch number
    const lastBatch = await this.prisma.allocationBatch.findFirst({
      where: { externalRequestId: String(requestId) },
      orderBy: { batchNumber: 'desc' },
    });
    const batchNumber = (lastBatch?.batchNumber || 0) + 1;

    // 3. Create allocation batch
    const batch = await this.prisma.allocationBatch.create({
      data: {
        externalRequestId: String(requestId),
        batchNumber,
        targetCount,
        status: AllocationBatchStatus.PROCESSING,
        startedAt: new Date(),
      },
    });

    // 4. Allocate websites
    const allocation = await this.allocateWebsites(
      batch.id,
      highTrafficTarget,
      lowTrafficTarget
    );

    // 5. Update batch with results
    await this.prisma.allocationBatch.update({
      where: { id: batch.id },
      data: {
        allocatedCount: allocation.websites.length,
        highTrafficCount: allocation.highTrafficCount,
        lowTrafficCount: allocation.lowTrafficCount,
        status: AllocationBatchStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    // 6. Insert into MySQL entity_link
    if (allocation.websites.length > 0) {
      const links = allocation.websites.map((w) => ({
        entityRequestId: requestId,
        email: requestData.email,
        username: requestData.username,
        about: requestData.about,
        site: w.domain,
        accountType: requestData.accountType,
        // Xác định type dựa trên trafficType: HIGH -> normal, LOW -> captcha
        trafficType: w.trafficType === TrafficType.HIGH ? 'normal' as const : 'captcha' as const,
      }));

      await this.mysqlRepo.entityLink.insertMany(links);
    }

    // Log gán tool và phân bổ website
    this.fastify.log.info(
      `Request ${requestId}: Gán tool "${toolPair.combined}", phân bổ ${allocation.websites.length} websites (high: ${allocation.highTrafficCount}, low: ${allocation.lowTrafficCount})`
    );

    return {
      batchId: batch.id,
      externalRequestId: String(requestId),
      allocatedCount: allocation.websites.length,
      highTrafficCount: allocation.highTrafficCount,
      lowTrafficCount: allocation.lowTrafficCount,
      websites: allocation.websites,
    };
  }

  // ==================== WEBSITE ALLOCATION ====================

  /**
   * Allocate websites based on traffic distribution
   * 50% high traffic (>= 50k), 50% low traffic (< 50k)
   * Prioritized by success rate
   */
  async allocateWebsites(
    batchId: string,
    highTrafficTarget: number,
    lowTrafficTarget: number
  ): Promise<{
    websites: Array<{
      websiteId: string;
      domain: string;
      trafficType: TrafficType;
    }>;
    highTrafficCount: number;
    lowTrafficCount: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get websites that haven't exceeded daily allocation limit
    // and are in RUNNING status
    const availableWebsites = await this.getAvailableWebsites(today);

    // Separate by traffic
    const highTrafficWebsites = availableWebsites.filter(
      (w) => w.traffic >= TRAFFIC_THRESHOLD
    );
    const lowTrafficWebsites = availableWebsites.filter(
      (w) => w.traffic < TRAFFIC_THRESHOLD
    );

    // Sort by success rate (higher first)
    highTrafficWebsites.sort((a, b) => b.successRate - a.successRate);
    lowTrafficWebsites.sort((a, b) => b.successRate - a.successRate);

    // Select websites
    const selectedHigh = highTrafficWebsites.slice(0, highTrafficTarget);
    const selectedLow = lowTrafficWebsites.slice(0, lowTrafficTarget);

    // Create allocation items and update daily allocations
    const allSelected = [
      ...selectedHigh.map((w) => ({ ...w, trafficType: TrafficType.HIGH })),
      ...selectedLow.map((w) => ({ ...w, trafficType: TrafficType.LOW })),
    ];

    // Batch create allocation items
    if (allSelected.length > 0) {
      await this.prisma.allocationItem.createMany({
        data: allSelected.map((w) => ({
          batchId,
          websiteId: w.id,
          domain: w.domain,
          trafficType: w.trafficType,
          priorityScore: w.successRate,
          status: AllocationItemStatus.PENDING,
        })),
      });

      // Update daily allocations
      await this.updateDailyAllocations(
        allSelected.map((w) => w.id),
        today
      );
    }

    return {
      websites: allSelected.map((w) => ({
        websiteId: w.id,
        domain: w.domain,
        trafficType: w.trafficType,
      })),
      highTrafficCount: selectedHigh.length,
      lowTrafficCount: selectedLow.length,
    };
  }

  /**
   * Get websites available for allocation
   * - Status = RUNNING
   * - Daily allocation count < MAX_DAILY_ALLOCATIONS
   */
  async getAvailableWebsites(date: Date): Promise<WebsiteForAllocation[]> {
    // Get websites with their daily allocation count
    const websites = await this.prisma.website.findMany({
      where: {
        status: WebsiteStatus.RUNNING,
        deletedAt: null,
      },
      select: {
        id: true,
        domain: true,
        metrics: true,
        stats: {
          select: {
            successRate: true,
          },
          orderBy: { periodStart: 'desc' },
          take: 1,
        },
      },
    });

    // Get daily allocations for today
    const dailyAllocations = await this.prisma.dailyAllocation.findMany({
      where: { date },
    });
    const allocationMap = new Map(
      dailyAllocations.map((d) => [d.websiteId, d.allocationCount])
    );

    // Filter and transform
    return websites
      .filter((w) => {
        const dailyCount = allocationMap.get(w.id) || 0;
        return dailyCount < MAX_DAILY_ALLOCATIONS;
      })
      .map((w) => {
        const metrics = w.metrics as Record<string, unknown> | null;
        return {
          id: w.id,
          domain: w.domain,
          traffic: (metrics?.traffic as number) || 0,
          successRate: w.stats[0]?.successRate || 0,
        };
      });
  }

  /**
   * Update daily allocation counts
   */
  async updateDailyAllocations(
    websiteIds: string[],
    date: Date
  ): Promise<void> {
    // Upsert daily allocations
    for (const websiteId of websiteIds) {
      await this.prisma.dailyAllocation.upsert({
        where: {
          websiteId_date: { websiteId, date },
        },
        create: {
          websiteId,
          date,
          allocationCount: 1,
        },
        update: {
          allocationCount: { increment: 1 },
        },
      });
    }
  }

  // ==================== RESULT SYNC ====================

  /**
   * Sync results from MySQL when EntityRequest is completed
   * Flow:
   * 1. Check EntityRequest status in MySQL (batch query)
   * 2. If completed, sync all entity_link results (batch query)
   * 3. Update AllocationItem statuses (batch update)
   * 4. Update DailyAllocation counts
   * 5. Update WebsiteStats with new success rates
   *
   * OPTIMIZED: Sử dụng batch queries để giảm số lượng kết nối DB
   * - 1 query lấy tất cả batches từ PostgreSQL
   * - 1 query lấy tất cả requests từ MySQL (thay vì N queries)
   * - 1 query lấy tất cả entity_links từ MySQL (thay vì N queries)
   */
  async syncCompletedRequests(): Promise<{
    syncedRequests: number;
    updatedWebsites: number;
  }> {
    let syncedRequests = 0;
    const websitesToUpdate = new Set<string>();

    // Get all COMPLETED batches to check for status changes
    // Không chỉ lấy batches có items chưa sync, mà lấy tất cả để detect status changes
    const batches = await this.prisma.allocationBatch.findMany({
      where: {
        status: AllocationBatchStatus.COMPLETED,
      },
      include: {
        items: true,
      },
    });

    if (batches.length === 0) {
      return { syncedRequests: 0, updatedWebsites: 0 };
    }

    // Collect all unique request IDs
    const requestIds = [...new Set(batches.map((b) => b.externalRequestId))];

    // BATCH QUERY 1: Lấy tất cả requests từ MySQL trong 1 query
    const allRequests = await this.mysqlRepo.entityRequest.findByIds(requestIds);
    const requestStatusMap = new Map(
      allRequests.map((r) => [String(r.id), r.status])
    );

    // Lọc ra các request đã completed
    const completedRequestIds = requestIds.filter(
      (id) => requestStatusMap.get(id) === 'completed'
    );

    if (completedRequestIds.length === 0) {
      return { syncedRequests: 0, updatedWebsites: 0 };
    }

    // BATCH QUERY 2: Lấy tất cả entity_links từ MySQL trong 1 query
    const allLinksMap = await this.mysqlRepo.entityLink.findByRequestIds(completedRequestIds);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Prepare batch updates
    const itemsToUpdate: Array<{
      id: string;
      status: AllocationItemStatus;
      completedAt: Date | null;
      resultSyncedAt: Date | null;
    }> = [];

    // Track daily allocation changes for batch upsert
    const dailySuccessMap = new Map<string, number>();
    const dailyFailureMap = new Map<string, number>();

    // Process each batch
    for (const batch of batches) {
      const requestId = batch.externalRequestId;

      // Skip if request is not completed
      if (requestStatusMap.get(requestId) !== 'completed') {
        continue;
      }

      // Get links for this request from the batch query result
      const links = allLinksMap.get(requestId) || [];
      const linkStatusMap = new Map(
        links.map((l) => [l.site, l.status])
      );

      // Process each item
      for (const item of batch.items) {
        const linkStatus = linkStatusMap.get(item.domain);

        // Note: MySQL có thể lưu status với dấu gạch dưới hoặc khoảng trắng
        // Cần check cả 2 format để đảm bảo tương thích
        const status = linkStatus as string;

        // Determine new status based on entity_link status
        let newStatus: AllocationItemStatus;

        if (!status || status === 'new') {
          newStatus = AllocationItemStatus.RUNNING;
        } else if (status === 'finish' || status === 'fail connecting' || status === 'fail_connecting') {
          // fail connecting / fail_connecting = đã qua register + profile, chỉ lỗi ở bước connecting
          // -> tính là SUCCESS
          newStatus = AllocationItemStatus.SUCCESS;
        } else if (status === 'cancel') {
          newStatus = AllocationItemStatus.CANCELLED;
        } else {
          newStatus = AllocationItemStatus.FAILED;
        }

        const isCompleted = status !== 'new' && status !== undefined;

        // Chỉ update nếu status thay đổi hoặc chưa được sync
        const needsUpdate = !item.resultSyncedAt || item.status !== newStatus;

        if (needsUpdate && isCompleted) {
          itemsToUpdate.push({
            id: item.id,
            status: newStatus,
            completedAt: new Date(),
            resultSyncedAt: new Date(),
          });
        }

        // Thêm vào danh sách websites cần cập nhật stats nếu là SUCCESS hoặc FAILED
        if (newStatus === AllocationItemStatus.SUCCESS || newStatus === AllocationItemStatus.FAILED) {
          websitesToUpdate.add(item.websiteId);

          // Track daily allocation changes chỉ cho items mới sync hoặc thay đổi status
          if (needsUpdate && isCompleted) {
            const key = item.websiteId;
            if (status === 'finish' || status === 'fail connecting' || status === 'fail_connecting') {
              dailySuccessMap.set(key, (dailySuccessMap.get(key) || 0) + 1);
            } else {
              dailyFailureMap.set(key, (dailyFailureMap.get(key) || 0) + 1);
            }
          }
        }
      }

      syncedRequests++;
    }

    // BATCH UPDATE: Update all allocation items using transaction
    if (itemsToUpdate.length > 0) {
      await this.prisma.$transaction(
        itemsToUpdate.map((item) =>
          this.prisma.allocationItem.update({
            where: { id: item.id },
            data: {
              status: item.status,
              completedAt: item.completedAt,
              resultSyncedAt: item.resultSyncedAt,
            },
          })
        )
      );
    }

    // BATCH UPSERT: Update daily allocations
    const dailyUpserts: Promise<unknown>[] = [];

    for (const [websiteId, count] of dailySuccessMap) {
      dailyUpserts.push(
        this.prisma.dailyAllocation.upsert({
          where: { websiteId_date: { websiteId, date: today } },
          create: { websiteId, date: today, successCount: count },
          update: { successCount: { increment: count } },
        })
      );
    }

    for (const [websiteId, count] of dailyFailureMap) {
      dailyUpserts.push(
        this.prisma.dailyAllocation.upsert({
          where: { websiteId_date: { websiteId, date: today } },
          create: { websiteId, date: today, failureCount: count },
          update: { failureCount: { increment: count } },
        })
      );
    }

    if (dailyUpserts.length > 0) {
      await Promise.all(dailyUpserts);
    }

    // Update WebsiteStats for all affected websites
    if (websitesToUpdate.size > 0) {
      await this.updateWebsiteStats(Array.from(websitesToUpdate));
    }

    return {
      syncedRequests,
      updatedWebsites: websitesToUpdate.size,
    };
  }

  /**
   * Update WebsiteStats with calculated success rates
   * Called after syncing results from completed requests
   */
  async updateWebsiteStats(websiteIds: string[]): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const periodStart = new Date(today);
    periodStart.setDate(periodStart.getDate() - 30); // Last 30 days

    for (const websiteId of websiteIds) {
      // Get all allocation items for this website in the period
      const items = await this.prisma.allocationItem.findMany({
        where: {
          websiteId,
          allocatedAt: { gte: periodStart },
          status: {
            in: [AllocationItemStatus.SUCCESS, AllocationItemStatus.FAILED],
          },
        },
      });

      if (items.length === 0) continue;

      const successCount = items.filter(
        (i: { status: AllocationItemStatus }) => i.status === AllocationItemStatus.SUCCESS
      ).length;
      const failureCount = items.filter(
        (i: { status: AllocationItemStatus }) => i.status === AllocationItemStatus.FAILED
      ).length;
      const totalAttempts = successCount + failureCount;
      const successRate = totalAttempts > 0 ? (successCount / totalAttempts) * 100 : 0;

      // Find or create WebsiteStats for MONTHLY period (system-level, userId = null)
      const existingStats = await this.prisma.websiteStats.findFirst({
        where: {
          websiteId,
          userId: null,
          periodType: 'MONTHLY',
          periodStart,
        },
      });

      if (existingStats) {
        await this.prisma.websiteStats.update({
          where: { id: existingStats.id },
          data: {
            periodEnd: today,
            totalAttempts,
            successCount,
            failureCount,
            successRate,
          },
        });
      } else {
        await this.prisma.websiteStats.create({
          data: {
            websiteId,
            periodType: 'MONTHLY',
            periodStart,
            periodEnd: today,
            totalAttempts,
            successCount,
            failureCount,
            successRate,
          },
        });
      }

      this.fastify.log.debug(
        `Updated stats for website ${websiteId}: ${successRate.toFixed(2)}% success rate (${successCount}/${totalAttempts})`
      );
    }
  }

  /**
   * Get success rate for a specific website
   */
  async getWebsiteSuccessRate(websiteId: string): Promise<{
    successRate: number;
    totalAttempts: number;
    successCount: number;
    failureCount: number;
  }> {
    const stats = await this.prisma.websiteStats.findFirst({
      where: {
        websiteId,
        periodType: 'MONTHLY',
      },
      orderBy: { periodStart: 'desc' },
    });

    return {
      successRate: stats?.successRate ?? 0,
      totalAttempts: stats?.totalAttempts ?? 0,
      successCount: stats?.successCount ?? 0,
      failureCount: stats?.failureCount ?? 0,
    };
  }

  /**
   * Get allocation results for a specific request
   */
  async getRequestAllocationResults(externalRequestId: string): Promise<{
    totalAllocated: number;
    successCount: number;
    failureCount: number;
    pendingCount: number;
    successRate: number;
    websites: Array<{
      domain: string;
      trafficType: TrafficType;
      status: AllocationItemStatus;
      completedAt: Date | null;
    }>;
  }> {
    const batches = await this.prisma.allocationBatch.findMany({
      where: { externalRequestId },
      include: {
        items: {
          select: {
            domain: true,
            trafficType: true,
            status: true,
            completedAt: true,
          },
        },
      },
    });

    type ItemType = { domain: string; trafficType: TrafficType; status: AllocationItemStatus; completedAt: Date | null };
    const allItems: ItemType[] = batches.flatMap((b: { items: ItemType[] }) => b.items);
    const successCount = allItems.filter(
      (i: ItemType) => i.status === AllocationItemStatus.SUCCESS
    ).length;
    const failureCount = allItems.filter(
      (i: ItemType) => i.status === AllocationItemStatus.FAILED
    ).length;
    const pendingCount = allItems.filter(
      (i: ItemType) => i.status === AllocationItemStatus.PENDING || i.status === AllocationItemStatus.RUNNING
    ).length;
    const completedCount = successCount + failureCount;
    const successRate = completedCount > 0 ? (successCount / completedCount) * 100 : 0;

    return {
      totalAllocated: allItems.length,
      successCount,
      failureCount,
      pendingCount,
      successRate,
      websites: allItems,
    };
  }

  // ==================== ALERTS ====================

  /**
   * Create a system alert
   */
  async createAlert(params: {
    type: AlertType;
    severity: AlertSeverity;
    title: string;
    message: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.systemAlert.create({
      data: {
        type: params.type,
        severity: params.severity,
        title: params.title,
        message: params.message,
        entityType: params.entityType,
        entityId: params.entityId,
        metadata: params.metadata as Prisma.InputJsonValue,
      },
    });
  }

  // ==================== STATISTICS ====================

  /**
   * Get allocation statistics
   */
  async getStatistics(): Promise<{
    todayAllocations: number;
    todaySuccess: number;
    todayFailure: number;
    pendingBatches: number;
    totalBatches: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [dailyStats, pendingBatches, totalBatches] = await Promise.all([
      this.prisma.dailyAllocation.aggregate({
        where: { date: today },
        _sum: {
          allocationCount: true,
          successCount: true,
          failureCount: true,
        },
      }),
      this.prisma.allocationBatch.count({
        where: { status: AllocationBatchStatus.PENDING },
      }),
      this.prisma.allocationBatch.count(),
    ]);

    return {
      todayAllocations: dailyStats._sum.allocationCount || 0,
      todaySuccess: dailyStats._sum.successCount || 0,
      todayFailure: dailyStats._sum.failureCount || 0,
      pendingBatches,
      totalBatches,
    };
  }

  // ==================== FORCE RESYNC ====================

  /**
   * Force resync tất cả allocation results từ MySQL
   * Bỏ qua điều kiện resultSyncedAt để sync lại tất cả
   *
   * OPTIMIZED: Sử dụng batch queries để giảm số lượng kết nối DB
   * - 1 query lấy tất cả batches từ PostgreSQL
   * - 1 query lấy tất cả entity_links từ MySQL (thay vì N queries)
   * - Transaction để batch update items
   */
  async forceResyncAllResults(): Promise<{
    syncedBatches: number;
    updatedItems: number;
    updatedWebsites: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let syncedBatches = 0;
    let updatedItems = 0;
    const websitesToUpdate = new Set<string>();

    // Lấy tất cả batches đã COMPLETED hoặc PROCESSING
    const batches = await this.prisma.allocationBatch.findMany({
      where: {
        status: {
          in: [AllocationBatchStatus.COMPLETED, AllocationBatchStatus.PROCESSING],
        },
      },
      include: {
        items: true,
      },
    });

    if (batches.length === 0) {
      return { syncedBatches: 0, updatedItems: 0, updatedWebsites: 0, errors: [] };
    }

    this.fastify.log.info(`Force resync: Found ${batches.length} batches to process`);

    // Collect all unique request IDs
    const requestIds = [...new Set(batches.map((b) => b.externalRequestId))];

    // BATCH QUERY: Lấy tất cả entity_links từ MySQL trong 1 query
    const allLinksMap = await this.mysqlRepo.entityLink.findByRequestIds(requestIds);

    // Prepare batch updates
    const itemsToUpdate: Array<{
      id: string;
      status: AllocationItemStatus;
      completedAt: Date | null;
      resultSyncedAt: Date | null;
    }> = [];

    for (const batch of batches) {
      try {
        const requestId = batch.externalRequestId;

        // Get links for this request from the batch query result
        const links = allLinksMap.get(requestId) || [];
        const linkStatusMap = new Map(
          links.map((l) => [l.site, l.status])
        );

        // Process each item
        for (const item of batch.items) {
          const linkStatus = linkStatusMap.get(item.domain);

          // Determine new status based on entity_link status
          // Note: MySQL có thể lưu status với dấu gạch dưới hoặc khoảng trắng
          const status = linkStatus as string;
          let newStatus: AllocationItemStatus;

          if (!status || status === 'new') {
            newStatus = AllocationItemStatus.RUNNING;
          } else if (status === 'finish' || status === 'fail connecting' || status === 'fail_connecting') {
            newStatus = AllocationItemStatus.SUCCESS;
          } else if (status === 'cancel') {
            newStatus = AllocationItemStatus.CANCELLED;
          } else {
            newStatus = AllocationItemStatus.FAILED;
          }

          // Chỉ thêm vào batch update nếu status thay đổi
          if (item.status !== newStatus) {
            const isCompleted = status !== 'new' && status !== undefined;
            itemsToUpdate.push({
              id: item.id,
              status: newStatus,
              completedAt: isCompleted ? new Date() : null,
              resultSyncedAt: isCompleted ? new Date() : null,
            });
          }

          // Thêm vào danh sách websites cần cập nhật stats
          if (newStatus === AllocationItemStatus.SUCCESS || newStatus === AllocationItemStatus.FAILED) {
            websitesToUpdate.add(item.websiteId);
          }
        }

        syncedBatches++;
      } catch (error) {
        const errorMsg = `Error processing batch ${batch.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        this.fastify.log.error(errorMsg);
      }
    }

    // BATCH UPDATE: Update all allocation items using transaction
    if (itemsToUpdate.length > 0) {
      try {
        await this.prisma.$transaction(
          itemsToUpdate.map((item) =>
            this.prisma.allocationItem.update({
              where: { id: item.id },
              data: {
                status: item.status,
                completedAt: item.completedAt,
                resultSyncedAt: item.resultSyncedAt,
              },
            })
          )
        );
        updatedItems = itemsToUpdate.length;
      } catch (error) {
        const errorMsg = `Error batch updating items: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        this.fastify.log.error(errorMsg);
      }
    }

    // Update WebsiteStats cho tất cả websites bị ảnh hưởng
    if (websitesToUpdate.size > 0) {
      this.fastify.log.info(`Updating stats for ${websitesToUpdate.size} websites`);
      await this.updateWebsiteStats(Array.from(websitesToUpdate));
    }

    return {
      syncedBatches,
      updatedItems,
      updatedWebsites: websitesToUpdate.size,
      errors,
    };
  }

  /**
   * Recalculate success rate cho tất cả websites
   * Dùng khi cần tính lại stats mà không cần sync từ MySQL
   */
  async recalculateAllWebsiteStats(): Promise<{
    updatedWebsites: number;
  }> {
    // Lấy tất cả websiteIds có trong allocation_items
    const websiteIds = await this.prisma.allocationItem.findMany({
      where: {
        status: {
          in: [AllocationItemStatus.SUCCESS, AllocationItemStatus.FAILED],
        },
      },
      select: { websiteId: true },
      distinct: ['websiteId'],
    });

    const uniqueIds = websiteIds.map((w) => w.websiteId);
    this.fastify.log.info(`Recalculating stats for ${uniqueIds.length} websites`);

    await this.updateWebsiteStats(uniqueIds);

    return {
      updatedWebsites: uniqueIds.length,
    };
  }
}
