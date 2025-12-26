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
   * 1. Check EntityRequest status in MySQL
   * 2. If completed, sync all entity_link results
   * 3. Update AllocationItem statuses
   * 4. Update DailyAllocation counts
   * 5. Update WebsiteStats with new success rates
   */
  async syncCompletedRequests(): Promise<{
    syncedRequests: number;
    updatedWebsites: number;
  }> {
    let syncedRequests = 0;
    const websitesToUpdate = new Set<string>();

    // Get batches that have unsynced items (resultSyncedAt is null)
    const batches = await this.prisma.allocationBatch.findMany({
      where: {
        status: AllocationBatchStatus.COMPLETED,
        items: {
          some: {
            resultSyncedAt: null,
          },
        },
      },
      include: {
        items: {
          where: {
            resultSyncedAt: null,
          },
        },
      },
    });

    for (const batch of batches) {
      const requestId = batch.externalRequestId;

      // Check if request is completed in MySQL
      const request = await this.mysqlRepo.entityRequest.findById(requestId);
      if (!request || request.status !== 'completed') {
        continue; // Skip if not completed yet
      }

      // Get all links for this request
      const allLinks = await this.mysqlRepo.entityLink.findByRequestId(requestId);
      const linkStatusMap = new Map(
        allLinks.map((l) => [l.site, l.status])
      );

      // Get ALL items for this batch (including already synced ones for stats)
      const allItems = await this.prisma.allocationItem.findMany({
        where: { batchId: batch.id },
      });

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Update each allocation item
      for (const item of allItems) {
        const linkStatus = linkStatusMap.get(item.domain);

        // Skip if already synced
        if (item.resultSyncedAt) {
          websitesToUpdate.add(item.websiteId);
          continue;
        }

        // Determine new status based on entity_link status
        let newStatus: AllocationItemStatus;
        let shouldUpdateStats = false;

        if (!linkStatus || linkStatus === 'new') {
          // Still running or not found
          newStatus = AllocationItemStatus.RUNNING;
        } else if (linkStatus === 'finish') {
          newStatus = AllocationItemStatus.SUCCESS;
          shouldUpdateStats = true;
        } else if (linkStatus === 'cancel') {
          // Cancel = chưa được chạy, không tính vào success/failure rate
          newStatus = AllocationItemStatus.CANCELLED;
        } else {
          // failed và các status khác
          newStatus = AllocationItemStatus.FAILED;
          shouldUpdateStats = true;
        }

        // Update allocation item
        const isCompleted = linkStatus !== 'new' && linkStatus !== undefined;
        await this.prisma.allocationItem.update({
          where: { id: item.id },
          data: {
            status: newStatus,
            completedAt: isCompleted ? new Date() : null,
            resultSyncedAt: isCompleted ? new Date() : null,
          },
        });

        // Update daily allocation counts - chỉ tính finish và failed, không tính cancel
        if (shouldUpdateStats) {
          if (linkStatus === 'finish') {
            await this.prisma.dailyAllocation.upsert({
              where: {
                websiteId_date: { websiteId: item.websiteId, date: today },
              },
              create: {
                websiteId: item.websiteId,
                date: today,
                successCount: 1,
              },
              update: {
                successCount: { increment: 1 },
              },
            });
          } else if (linkStatus === 'failed') {
            await this.prisma.dailyAllocation.upsert({
              where: {
                websiteId_date: { websiteId: item.websiteId, date: today },
              },
              create: {
                websiteId: item.websiteId,
                date: today,
                failureCount: 1,
              },
              update: {
                failureCount: { increment: 1 },
              },
            });
          }
          websitesToUpdate.add(item.websiteId);
        }
      }

      syncedRequests++;
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
}
