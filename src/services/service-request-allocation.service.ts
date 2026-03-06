import { FastifyInstance } from 'fastify';
import {
  PrismaClient,
  WebsiteStatus,
  WebsiteType,
  AllocationBatchStatus,
  AllocationItemStatus,
  TrafficType,
  AlertType,
  AlertSeverity,
  ServiceType,
  RequestStatus,
  ToolService,
  Prisma,
  ServiceRequest,
} from '@prisma/client';
import { MySQLExternalRepositories } from '../repositories/mysql-external';
import { AllocationMetricsService } from './allocation/allocation-metrics.service';
import {
  isSuccessByProfile,
  shouldCountOnce,
  TERMINAL_STATUSES,
} from './allocation/allocation-rules';
import { calculateSupplementDeficit } from './allocation/commands/supplement-requests.command';
import { calculateRequestTimeoutMinutes } from './allocation/commands/timeout-requests.command';
import { CompleteTaskUseCase } from './allocation/use-cases/complete-task.use-case';
import { ReleaseExpiredClaimsUseCase } from './allocation/use-cases/release-expired-claims.use-case';
import { TimeoutExpiredRequestsUseCase } from './allocation/use-cases/timeout-requests.use-case';
import { SupplementRequestsUseCase } from './allocation/use-cases/supplement-requests.use-case';

// ==================== TYPES ====================

interface WebsiteForAllocation {
  id: string;
  domain: string;
  traffic: number;
  successRate: number;
  dailyCount: number; // how many times allocated today (for round-robin distribution)
}

interface AllocationResult {
  batchId: string;
  requestId: string;
  allocatedCount: number;
  highTrafficCount: number;
  lowTrafficCount: number;
  websites: Array<{
    websiteId: string;
    domain: string;
    trafficType: TrafficType;
  }>;
}

interface ClaimResult {
  success: boolean;
  items: Array<{
    id: string;
    domain: string;
    serviceType: ServiceType;
    linkData: unknown;
    linkProfile: string | null;
    linkPost: string | null;
    requestId: string | null;
  }>;
  message?: string;
}

interface ToolPairInfo {
  pairNumber: string;
  idToolValue: string;
  customerType: string;
  service: ToolService;
}

interface AssignmentDetail {
  requestId: string;
  idTool: string;
  priority: string;
  auctionPrice: string | null;
}

interface CachedConfig {
  value: unknown;
  expiresAt: number;
}

// ==================== CONSTANTS ====================

// Traffic threshold: >= 50k is HIGH, < 50k is LOW
const TRAFFIC_THRESHOLD = 50000;

// Maximum allocations per website per day
const MAX_DAILY_ALLOCATIONS = 3;

// Default allocation multiplier: allocate 2.5x entity_limit for buffer
const DEFAULT_ALLOCATION_MULTIPLIER = 2.5;

// Default claim timeout in minutes
const DEFAULT_CLAIM_TIMEOUT = 5;

// Default request completion time per 100 entities (in minutes)
// For entityLimit >= 100: timeout = (entityLimit / 100) * this value
// For entityLimit < 100: timeout = 30 minutes (fixed, priority completion)
const DEFAULT_REQUEST_COMPLETION_TIME_PER_100 = 35;

// Fixed timeout for small requests (entityLimit < 100)
const SMALL_REQUEST_TIMEOUT_MINUTES = 30;

// Config cache TTL (5 minutes)
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

// Website cache TTL (1 minute) - for available websites
const WEBSITE_CACHE_TTL_MS = 60 * 1000;

// Config keys
const CONFIG_KEYS = {
  ALLOCATION_MULTIPLIER: 'ALLOCATION_MULTIPLIER',
  CLAIM_TIMEOUT_MINUTES: 'CLAIM_TIMEOUT_MINUTES',
  MAX_DAILY_ALLOCATIONS: 'MAX_DAILY_ALLOCATIONS',
  TRAFFIC_THRESHOLD: 'TRAFFIC_THRESHOLD',
  REQUEST_COMPLETION_TIME_PER_100: 'REQUEST_COMPLETION_TIME_PER_100',
  EMAIL_DOT_COUNT: 'EMAIL_DOT_COUNT',
  COMPLETION_THRESHOLD_PERCENT: 'COMPLETION_THRESHOLD_PERCENT',
} as const;

const DEFAULT_EMAIL_DOT_COUNT = 2;

// Default completion threshold percent (110% = need 110% of entityLimit to consider target reached)
const DEFAULT_COMPLETION_THRESHOLD_PERCENT = 110;

// Max retries for supplement runs (retryCount >= this â†’ stop re-running)
const MAX_SUPPLEMENT_RETRIES = 2;

/**
 * Generate a random password with format like: dg2n@gCcuvcl
 * - 12 characters total
 * - 1 special character
 * - 1 uppercase letter
 * - 1-3 numbers
 * - Rest are lowercase letters
 */
function generateRandomPassword(): string {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const special = '@#$%&*';

  const chars: string[] = [];

  // Add exactly 1 special character
  chars.push(special[Math.floor(Math.random() * special.length)]);

  // Add exactly 1 uppercase letter
  chars.push(uppercase[Math.floor(Math.random() * uppercase.length)]);

  // Add 1-3 numbers (random count)
  const numCount = Math.floor(Math.random() * 3) + 1; // 1, 2, or 3
  for (let i = 0; i < numCount; i++) {
    chars.push(numbers[Math.floor(Math.random() * numbers.length)]);
  }

  // Fill the rest with lowercase letters (12 - 1 special - 1 uppercase - numCount numbers)
  const lowercaseCount = 12 - 1 - 1 - numCount;
  for (let i = 0; i < lowercaseCount; i++) {
    chars.push(lowercase[Math.floor(Math.random() * lowercase.length)]);
  }

  // Shuffle the password
  return chars.sort(() => Math.random() - 0.5).join('');
}

// ==================== SERVICE ====================

export class ServiceRequestAllocationService {
  private prisma: PrismaClient;
  private mysqlRepo: MySQLExternalRepositories | null = null;
  private allocationMetrics: AllocationMetricsService;
  private completeTaskUseCase: CompleteTaskUseCase;
  private releaseExpiredClaimsUseCase: ReleaseExpiredClaimsUseCase;
  private timeoutExpiredRequestsUseCase: TimeoutExpiredRequestsUseCase;
  private supplementRequestsUseCase: SupplementRequestsUseCase;

  // In-memory cache for configs
  private configCache: Map<string, CachedConfig> = new Map();

  // Cache for available websites (refreshed every minute)
  private websiteCache: {
    data: WebsiteForAllocation[] | null;
    expiresAt: number;
    serviceType?: ServiceType;
  } = { data: null, expiresAt: 0 };

  constructor(private fastify: FastifyInstance) {
    this.prisma = fastify.prisma;
    this.allocationMetrics = new AllocationMetricsService();
    this.completeTaskUseCase = new CompleteTaskUseCase({
      prisma: this.prisma,
      log: this.fastify.log,
      allocationMetrics: this.allocationMetrics,
    });
    this.releaseExpiredClaimsUseCase = new ReleaseExpiredClaimsUseCase({
      prisma: this.prisma,
      log: this.fastify.log,
    });
    this.timeoutExpiredRequestsUseCase = new TimeoutExpiredRequestsUseCase({
      prisma: this.prisma,
      log: this.fastify.log,
    });
    this.supplementRequestsUseCase = new SupplementRequestsUseCase({
      prisma: this.prisma,
      log: this.fastify.log,
    });
    // MySQL repo is optional - only used for syncing to legacy tables
    if (fastify.mysql) {
      this.mysqlRepo = new MySQLExternalRepositories(fastify.mysql);
    }
  }

  // ==================== CONFIG HELPERS (WITH CACHING) ====================

  /**
   * Get a config value from SystemConfig table with caching
   * Cache TTL: 5 minutes
   */
  async getConfig<T>(key: string, defaultValue: T): Promise<T> {
    const now = Date.now();

    // Check cache first
    const cached = this.configCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }

    try {
      const config = await this.prisma.systemConfig.findUnique({
        where: { key },
        select: { value: true, type: true },
      });

      let parsedValue: unknown = defaultValue;

      if (config) {
        switch (config.type) {
          case 'NUMBER':
            parsedValue = Number(config.value);
            break;
          case 'BOOLEAN':
            parsedValue = config.value.toLowerCase() === 'true';
            break;
          case 'JSON':
            parsedValue = JSON.parse(config.value);
            break;
          default:
            parsedValue = config.value;
        }
      }

      // Update cache
      this.configCache.set(key, {
        value: parsedValue,
        expiresAt: now + CONFIG_CACHE_TTL_MS,
      });

      return parsedValue as T;
    } catch (error) {
      this.fastify.log.warn({ key, error }, 'Failed to get config, using default');
      return defaultValue;
    }
  }

  /**
   * Get multiple configs in a single query (batch)
   */
  async getConfigs(keys: string[]): Promise<Map<string, unknown>> {
    const now = Date.now();
    const result = new Map<string, unknown>();
    const keysToFetch: string[] = [];

    // Check cache first
    for (const key of keys) {
      const cached = this.configCache.get(key);
      if (cached && cached.expiresAt > now) {
        result.set(key, cached.value);
      } else {
        keysToFetch.push(key);
      }
    }

    // Fetch remaining from DB
    if (keysToFetch.length > 0) {
      const configs = await this.prisma.systemConfig.findMany({
        where: { key: { in: keysToFetch } },
        select: { key: true, value: true, type: true },
      });

      for (const config of configs) {
        let parsedValue: unknown;
        switch (config.type) {
          case 'NUMBER':
            parsedValue = Number(config.value);
            break;
          case 'BOOLEAN':
            parsedValue = config.value.toLowerCase() === 'true';
            break;
          case 'JSON':
            parsedValue = JSON.parse(config.value);
            break;
          default:
            parsedValue = config.value;
        }

        result.set(config.key, parsedValue);
        this.configCache.set(config.key, {
          value: parsedValue,
          expiresAt: now + CONFIG_CACHE_TTL_MS,
        });
      }
    }

    return result;
  }

  /**
   * Clear config cache (call when config is updated)
   */
  clearConfigCache(key?: string): void {
    if (key) {
      this.configCache.delete(key);
    } else {
      this.configCache.clear();
    }
  }

  /**
   * Get allocation multiplier (configurable)
   */
  async getAllocationMultiplier(): Promise<number> {
    return this.getConfig(CONFIG_KEYS.ALLOCATION_MULTIPLIER, DEFAULT_ALLOCATION_MULTIPLIER);
  }

  /**
   * Get claim timeout in minutes
   */
  async getClaimTimeout(): Promise<number> {
    return this.getConfig(CONFIG_KEYS.CLAIM_TIMEOUT_MINUTES, DEFAULT_CLAIM_TIMEOUT);
  }

  /**
   * Get request completion time per 100 entities (in minutes)
   */
  async getRequestCompletionTimePer100(): Promise<number> {
    return this.getConfig(CONFIG_KEYS.REQUEST_COMPLETION_TIME_PER_100, DEFAULT_REQUEST_COMPLETION_TIME_PER_100);
  }

  /**
   * Get email dot count (max dots to add for accountType=multiple)
   */
  async getEmailDotCount(): Promise<number> {
    return this.getConfig(CONFIG_KEYS.EMAIL_DOT_COUNT, DEFAULT_EMAIL_DOT_COUNT);
  }

  /**
   * Get completion threshold percent (e.g. 110 = need 110% of entityLimit)
   */
  async getCompletionThresholdPercent(): Promise<number> {
    return this.getConfig(CONFIG_KEYS.COMPLETION_THRESHOLD_PERCENT, DEFAULT_COMPLETION_THRESHOLD_PERCENT);
  }

  /**
   * Calculate completion target based on entityLimit and threshold percent
   * VD: entityLimit=100, threshold=110 â†’ target=110
   * VD: entityLimit=200, threshold=110 â†’ target=220
   */
  getCompletionTarget(entityLimit: number, thresholdPercent: number): number {
    return Math.ceil(entityLimit * thresholdPercent / 100);
  }

  /**
   * Gmail dot trick: add random dots to email local part
   * Gmail ignores dots in local part, so u.ser@gmail.com = user@gmail.com
   * Each call produces a different variation for the same email
   *
   * @param email - Original email address
   * @param maxDots - Max number of dots to add (from config EMAIL_DOT_COUNT)
   */
  private modifyEmailWithDots(email: string, maxDots: number): string {
    const [localPart, domain] = email.split('@');
    if (!localPart || localPart.length < 2 || !domain || maxDots <= 0) {
      return email;
    }

    // Clean existing dots first to avoid double dots
    const cleanLocal = localPart.replace(/\./g, '');
    if (cleanLocal.length < 2) return email;

    // Limit dots based on local part length
    const effectiveMaxDots = Math.min(maxDots, cleanLocal.length - 1);
    const numDots = Math.floor(Math.random() * effectiveMaxDots) + 1;

    // Generate random unique positions (between chars, not at start)
    const possiblePositions: number[] = [];
    for (let i = 1; i < cleanLocal.length; i++) {
      possiblePositions.push(i);
    }

    // Fisher-Yates shuffle and take first numDots
    for (let i = possiblePositions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [possiblePositions[i], possiblePositions[j]] = [possiblePositions[j], possiblePositions[i]];
    }
    const dotPositions = possiblePositions.slice(0, numDots).sort((a, b) => a - b);

    // Insert dots at positions (from right to left to keep indices valid)
    let result = cleanLocal;
    for (let i = dotPositions.length - 1; i >= 0; i--) {
      const pos = dotPositions[i];
      result = result.slice(0, pos) + '.' + result.slice(pos);
    }

    return `${result}@${domain}`;
  }

  /**
   * Add exactly one new dot to email local part while preserving existing dots.
   * - Keeps all existing dots unchanged
   * - Avoids creating consecutive dots
   * - If no valid position exists, returns original email
   */
  private addOneDotPreserveExisting(email: string): string {
    const [localPart, domain] = email.split('@');
    if (!localPart || !domain || localPart.length < 2) {
      return email;
    }

    const validPositions: number[] = [];

    // Insert positions are between characters: [1..length-1]
    for (let i = 1; i < localPart.length; i++) {
      const left = localPart[i - 1];
      const right = localPart[i];

      // Keep existing dots and avoid creating ".."
      if (left !== '.' && right !== '.') {
        validPositions.push(i);
      }
    }

    if (validPositions.length === 0) {
      return email;
    }

    const randomIndex = Math.floor(Math.random() * validPositions.length);
    const insertPos = validPositions[randomIndex];
    const newLocal = localPart.slice(0, insertPos) + '.' + localPart.slice(insertPos);

    return `${newLocal}@${domain}`;
  }

  /**
   * Calculate timeout for a request based on entityLimit
   * - entityLimit >= 100: timeout = (entityLimit / 100) * completionTimePer100
   * - entityLimit < 100: timeout = 30 minutes (fixed, priority completion)
   */
  calculateRequestTimeout(entityLimit: number, completionTimePer100: number): number {
    return calculateRequestTimeoutMinutes(
      entityLimit,
      completionTimePer100,
      SMALL_REQUEST_TIMEOUT_MINUTES
    );
  }

  // ==================== MAIN ALLOCATION FLOW ====================

  /**
   * Process NEW requests and allocate websites
   * OPTIMIZED: Batch check existing batches, parallel processing
   */
  async processNewRequests(serviceType?: ServiceType): Promise<{
    processed: number;
    skipped: number;
    failed: number;
  }> {
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    // Find NEW requests
    const where: Prisma.ServiceRequestWhereInput = {
      status: RequestStatus.NEW,
      deletedAt: null,
      ...(serviceType && { serviceType }),
    };

    const newRequests = await this.prisma.serviceRequest.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 50, // Limit batch size to prevent memory issues
    });

    if (newRequests.length === 0) {
      return { processed, skipped, failed };
    }

    // OPTIMIZATION: Batch check existing batches in single query
    const requestIds = newRequests.map((r) => r.id);
    const existingBatches = await this.prisma.allocationBatch.findMany({
      where: { requestId: { in: requestIds } },
      select: { requestId: true },
      distinct: ['requestId'],
    });
    const existingBatchSet = new Set(existingBatches.map((b) => b.requestId));

    // Filter requests that need processing
    const requestsToProcess = newRequests.filter((r) => !existingBatchSet.has(r.id));
    skipped = newRequests.length - requestsToProcess.length;

    // Pre-fetch configs once for all requests
    const [multiplier, claimTimeout] = await Promise.all([
      this.getAllocationMultiplier(),
      this.getClaimTimeout(),
    ]);

    // Process requests (could be parallelized with concurrency limit)
    for (const request of requestsToProcess) {
      try {
        // Claim request atomically to prevent duplicate processing by concurrent workers.
        const claimResult = await this.prisma.serviceRequest.updateMany({
          where: {
            id: request.id,
            status: RequestStatus.NEW,
            deletedAt: null,
          },
          data: { status: RequestStatus.PENDING },
        });

        if (claimResult.count === 0) {
          skipped++;
          continue;
        }

        await this.allocateForRequestOptimized(request, multiplier, claimTimeout);

        processed++;
      } catch (error) {
        this.fastify.log.error({ err: error, requestId: request.id }, 'Failed to process request');
        await this.prisma.serviceRequest.updateMany({
          where: {
            id: request.id,
            status: RequestStatus.PENDING,
            deletedAt: null,
          },
          data: { status: RequestStatus.NEW },
        });
        await this.createAlert({
          type: AlertType.ALLOCATION_FAILED,
          severity: AlertSeverity.ERROR,
          title: 'Allocation Failed',
          message: `Failed to allocate for request ${request.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          entityType: 'ServiceRequest',
          entityId: request.id,
        });
        failed++;
      }
    }

    return { processed, skipped, failed };
  }

  /**
   * Re-allocate websites for RUNNING/PENDING requests that need more items
   *
   * Checks each active request:
   * 1. No items in NEW, REGISTERING, PROFILING status (all processed)
   * 2. completedLinks + failedLinks < entityLimit (results not enough)
   * 3. Request not timed out
   * â†’ Allocate additional websites based on deficit (entityLimit - completedLinks)
   *
   * Excludes domains already allocated to this request to avoid duplicates.
   */
  async reAllocateForActiveRequests(): Promise<{
    processed: number;
    skipped: number;
    details: Array<{
      requestId: string;
      deficit: number;
      allocated: number;
    }>;
  }> {
    let processed = 0;
    let skipped = 0;
    const details: Array<{ requestId: string; deficit: number; allocated: number }> = [];

    // Find PENDING/RUNNING requests that are not completed or timed out
    const activeRequests = await this.prisma.serviceRequest.findMany({
      where: {
        status: { in: [RequestStatus.PENDING, RequestStatus.RUNNING, RequestStatus.RE_RUNNING] },
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    if (activeRequests.length === 0) {
      return { processed: 0, skipped: 0, details: [] };
    }

    const activeRequestIds = activeRequests.map((r) => r.id);

    // Preload active item counts and excluded domains to reduce N+1 queries.
    const [activeItemCountsRaw, existingDomainRows] = await Promise.all([
      this.prisma.allocationItem.groupBy({
        by: ['requestId'],
        where: {
          requestId: { in: activeRequestIds },
          status: {
            in: [
              AllocationItemStatus.NEW,
              AllocationItemStatus.REGISTERING,
              AllocationItemStatus.PROFILING,
            ],
          },
        },
        _count: { _all: true },
      }),
      this.prisma.allocationItem.findMany({
        where: { requestId: { in: activeRequestIds } },
        select: { requestId: true, domain: true },
        distinct: ['requestId', 'domain'],
      }),
    ]);
    const activeItemCountMap = new Map<string, number>(
      activeItemCountsRaw.map((row) => [row.requestId || '', row._count._all])
    );
    const excludedDomainMap = new Map<string, Set<string>>();
    for (const row of existingDomainRows) {
      if (!row.requestId) continue;
      if (!excludedDomainMap.has(row.requestId)) {
        excludedDomainMap.set(row.requestId, new Set<string>());
      }
      excludedDomainMap.get(row.requestId)!.add(row.domain);
    }

    // For each request, check if it needs re-allocation
    const [multiplier, claimTimeout, thresholdPercent] = await Promise.all([
      this.getAllocationMultiplier(),
      this.getClaimTimeout(),
      this.getCompletionThresholdPercent(),
    ]);

    for (const request of activeRequests) {
      try {
        const config = request.config as Record<string, unknown> | null;
        const entityLimit = (config?.entityLimit as number) || 100;
        const completionTarget = this.getCompletionTarget(entityLimit, thresholdPercent);

        // Check if results are already sufficient (using configurable threshold)
        if (request.completedLinks >= completionTarget) {
          skipped++;
          continue;
        }

        // Count active items (still being processed or waiting to be claimed)
        const activeItemCount = activeItemCountMap.get(request.id) || 0;

        // If there are still active items, no need to re-allocate yet
        if (activeItemCount > 0) {
          skipped++;
          continue;
        }

        // Calculate deficit: how many more successful results we need (based on completion target)
        const deficit = calculateSupplementDeficit(completionTarget, request.completedLinks);
        if (deficit <= 0) {
          skipped++;
          continue;
        }

        // Calculate how many websites to allocate (deficit * multiplier for buffer)
        const targetCount = Math.ceil(deficit * multiplier);
        const highTrafficTarget = Math.ceil(targetCount * 0.5);
        const lowTrafficTarget = targetCount - highTrafficTarget;

        // Get domains already allocated to this request (to exclude duplicates)
        const excludedDomains = excludedDomainMap.get(request.id) || new Set<string>();

        // Check availability before allocating new websites.
        // If no websites available and request is RUNNING/RE_RUNNING, recycle failed items.
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let availableWebsites = await this.getAvailableWebsitesOptimized(today, request.serviceType);
        if (excludedDomains.size > 0) {
          availableWebsites = availableWebsites.filter((w) => !excludedDomains.has(w.domain));
        }

        const noAvailableWebsites = availableWebsites.length === 0;
        const canRecycleFailedItems =
          request.status === RequestStatus.RUNNING || request.status === RequestStatus.RE_RUNNING;

        if (noAvailableWebsites && canRecycleFailedItems) {
          const recycleResult = await this.prisma.$transaction(async (tx) => {
            return this.recycleFailedItemsForRequest(tx, request.id);
          }, { timeout: 30000 });

          if (recycleResult.recycledCount > 0) {
            processed++;
            details.push({
              requestId: request.id,
              deficit,
              allocated: recycleResult.recycledCount, // Keep API shape; value represents recycled items
            });

            this.fastify.log.info({
              requestId: request.id,
              deficit,
              recycledCount: recycleResult.recycledCount,
              emailUpdatedCount: recycleResult.emailUpdatedCount,
            }, 'No available websites - recycled FAIL_REGISTERING/FAIL_PROFILING items to NEW');
          } else {
            skipped++;
            this.fastify.log.debug({
              requestId: request.id,
              deficit,
            }, 'No available websites and no failed items to recycle');
          }

          continue;
        }

        // Allocate in a transaction
        const result = await this.prisma.$transaction(async (tx) => {
          // Get next batch number
          const lastBatch = await tx.allocationBatch.findFirst({
            where: { requestId: request.id },
            orderBy: { batchNumber: 'desc' },
            select: { batchNumber: true },
          });
          const batchNumber = (lastBatch?.batchNumber || 0) + 1;

          // Create allocation batch
          const batch = await tx.allocationBatch.create({
            data: {
              requestId: request.id,
              batchNumber,
              targetCount,
              status: AllocationBatchStatus.PROCESSING,
              startedAt: new Date(),
            },
          });

          // Generate password for this batch
          const generatedPassword = generateRandomPassword();

          // Allocate websites, excluding already-used domains
          const allocation = await this.allocateWebsitesOptimized(
            tx,
            batch.id,
            request.id,
            request.serviceType,
            highTrafficTarget,
            lowTrafficTarget,
            this.buildLinkData(request, generatedPassword),
            claimTimeout,
            excludedDomains
          );

          // Update batch
          await tx.allocationBatch.update({
            where: { id: batch.id },
            data: {
              allocatedCount: allocation.websites.length,
              highTrafficCount: allocation.highTrafficCount,
              lowTrafficCount: allocation.lowTrafficCount,
              status: AllocationBatchStatus.COMPLETED,
              completedAt: new Date(),
            },
          });

          // Update totalLinks on request
          await tx.serviceRequest.update({
            where: { id: request.id },
            data: { totalLinks: { increment: allocation.websites.length } },
          });

          return allocation;
        }, { timeout: 30000 });

        if (result.websites.length > 0) {
          processed++;
          details.push({
            requestId: request.id,
            deficit,
            allocated: result.websites.length,
          });

          this.fastify.log.info({
            requestId: request.id,
            deficit,
            allocated: result.websites.length,
            completedLinks: request.completedLinks,
            entityLimit,
          }, `Re-allocated ${result.websites.length} websites for request (deficit: ${deficit})`);
        } else {
          skipped++;
          this.fastify.log.debug({
            requestId: request.id,
            deficit,
          }, 'No available websites for re-allocation');
        }
      } catch (error) {
        this.fastify.log.error({ err: error, requestId: request.id }, 'Failed to re-allocate for request');
        skipped++;
      }
    }

    return { processed, skipped, details };
  }

  /**
   * Recycle failed items when no new websites are available.
   * - FAIL_REGISTERING / FAIL_PROFILING -> NEW
   * - claimedBy / claimedAt reset to null
   * - For linkData.email: add one new dot while preserving existing dots
   */
  private async recycleFailedItemsForRequest(
    tx: Prisma.TransactionClient,
    requestId: string
  ): Promise<{ recycledCount: number; emailUpdatedCount: number }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const failedItems = await tx.allocationItem.findMany({
      where: {
        requestId,
        status: {
          in: [AllocationItemStatus.FAIL_REGISTERING, AllocationItemStatus.FAIL_PROFILING],
        },
      },
      select: {
        id: true,
        websiteId: true,
        linkData: true,
      },
    });

    if (failedItems.length === 0) {
      return { recycledCount: 0, emailUpdatedCount: 0 };
    }

    let emailUpdatedCount = 0;

    for (const item of failedItems) {
      const updateData: Prisma.AllocationItemUpdateInput = {
        status: AllocationItemStatus.NEW,
        claimedBy: null,
        claimedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      };

      const linkData = item.linkData as Record<string, unknown> | null;
      if (linkData && typeof linkData === 'object' && typeof linkData.email === 'string') {
        const oldEmail = linkData.email;
        const newEmail = this.addOneDotPreserveExisting(oldEmail);
        if (newEmail !== oldEmail) {
          updateData.linkData = {
            ...linkData,
            email: newEmail,
          };
          emailUpdatedCount++;
        }
      }

      await tx.allocationItem.update({
        where: { id: item.id },
        data: updateData,
      });
    }

    // Recycle is a new allocation attempt for the same websites.
    await this.batchUpsertDailyAllocations(tx, failedItems.map((i) => i.websiteId), today);

    return {
      recycledCount: failedItems.length,
      emailUpdatedCount,
    };
  }

  /**
   * Allocate websites for a specific request (OPTIMIZED version)
   * Uses pre-fetched configs and batched operations
   */
  private async allocateForRequestOptimized(
    request: ServiceRequest,
    multiplier: number,
    claimTimeout: number,
    overrideEntityLimit?: number
  ): Promise<AllocationResult> {
    // Get entityLimit from config (or use override for supplement requests)
    const config = request.config as Record<string, unknown> | null;
    const entityLimit = overrideEntityLimit || (config?.entityLimit as number) || 100;

    // Calculate targets
    const targetCount = Math.ceil(entityLimit * multiplier);
    const highTrafficTarget = Math.ceil(targetCount * 0.5);
    const lowTrafficTarget = targetCount - highTrafficTarget;

    // Use transaction for atomic operations
    return this.prisma.$transaction(async (tx) => {
      // Get next batch number
      const lastBatch = await tx.allocationBatch.findFirst({
        where: { requestId: request.id },
        orderBy: { batchNumber: 'desc' },
        select: { batchNumber: true },
      });
      const batchNumber = (lastBatch?.batchNumber || 0) + 1;

      // Create allocation batch
      const batch = await tx.allocationBatch.create({
        data: {
          requestId: request.id,
          batchNumber,
          targetCount,
          status: AllocationBatchStatus.PROCESSING,
          startedAt: new Date(),
        },
      });

      // Generate a random password for all items in this request
      const generatedPassword = generateRandomPassword();

      // Allocate websites using optimized method
      const allocation = await this.allocateWebsitesOptimized(
        tx,
        batch.id,
        request.id, // Pass requestId for direct storage
        request.serviceType,
        highTrafficTarget,
        lowTrafficTarget,
        this.buildLinkData(request, generatedPassword),
        claimTimeout
      );

      // Update batch with results
      await tx.allocationBatch.update({
        where: { id: batch.id },
        data: {
          allocatedCount: allocation.websites.length,
          highTrafficCount: allocation.highTrafficCount,
          lowTrafficCount: allocation.lowTrafficCount,
          status: AllocationBatchStatus.COMPLETED,
          completedAt: new Date(),
        },
      });

      // Update request totalLinks
      await tx.serviceRequest.update({
        where: { id: request.id },
        data: { totalLinks: { increment: allocation.websites.length } },
      });

      this.fastify.log.info(
        { requestId: request.id, batchNumber, allocated: allocation.websites.length },
        `Allocated ${allocation.websites.length} websites (high: ${allocation.highTrafficCount}, low: ${allocation.lowTrafficCount})`
      );

      return {
        batchId: batch.id,
        requestId: request.id,
        allocatedCount: allocation.websites.length,
        highTrafficCount: allocation.highTrafficCount,
        lowTrafficCount: allocation.lowTrafficCount,
        websites: allocation.websites,
      };
    }, {
      timeout: 30000, // 30 second timeout for transaction
    });
  }

  /**
   * Build linkData from request config
   * @param request - The service request
   * @param generatedPassword - Auto-generated password for all items in this request
   */
  private buildLinkData(request: ServiceRequest, generatedPassword?: string): Record<string, unknown> {
    const config = request.config as Record<string, unknown> | null;
    if (!config) return {};

    switch (request.serviceType) {
      case ServiceType.ENTITY:
        return {
          email: config.email,
          appPassword: config.appPassword,
          username: config.username,
          password: generatedPassword, // Auto-generated password for registration
          about: config.about,
          accountType: config.accountType,
          firstName: config.firstName,
          lastName: config.lastName,
          phone: config.phone,
          address: config.address,
          location: config.location,
          avatar: config.avatar,
          cover: config.cover,
        };
      case ServiceType.BLOG2:
        return { blogGroupId: config.blogGroupId, data: config.data };
      case ServiceType.SOCIAL:
        return {
          socialGroupId: config.socialGroupId,
          website: config.website,
          percentage: config.percentage,
          unique_url: config.unique_url,
          data: config.data,
        };
      case ServiceType.PODCAST:
        return { podcastGroupId: config.podcastGroupId, data: config.data };
      case ServiceType.GG_STACKING:
        return {
          folderUrl: config.folderUrl,
          title: config.title,
          website: config.website,
          about: config.about,
          phone: config.phone,
          address: config.address,
          location: config.location,
          stackingConnect: config.stackingConnect,
          spinContent: config.spinContent,
          duplicate: config.duplicate,
        };
      default:
        return config;
    }
  }

  // ==================== WEBSITE ALLOCATION (OPTIMIZED) ====================

  /**
   * Allocate websites - OPTIMIZED version with transaction support
   * @param excludedDomains - Optional set of domains to exclude (used by re-allocation)
   */
  private async allocateWebsitesOptimized(
    tx: Prisma.TransactionClient,
    batchId: string,
    requestId: string,
    serviceType: ServiceType,
    highTrafficTarget: number,
    lowTrafficTarget: number,
    linkData: Record<string, unknown>,
    claimTimeout: number,
    excludedDomains?: Set<string>
  ): Promise<{
    websites: Array<{ websiteId: string; domain: string; trafficType: TrafficType }>;
    highTrafficCount: number;
    lowTrafficCount: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get available websites (uses caching)
    let availableWebsites = await this.getAvailableWebsitesOptimized(today, serviceType);

    // Filter out excluded domains (for re-allocation)
    if (excludedDomains && excludedDomains.size > 0) {
      availableWebsites = availableWebsites.filter((w) => !excludedDomains.has(w.domain));
    }

    // Separate by traffic
    const highTrafficWebsites = availableWebsites.filter((w) => w.traffic >= TRAFFIC_THRESHOLD);
    const lowTrafficWebsites = availableWebsites.filter((w) => w.traffic < TRAFFIC_THRESHOLD);

    // Select using Round-Robin + Weighted Random:
    // 1. Sort by dailyCount ASC (least allocated first) for even distribution
    // 2. Within same dailyCount tier, weighted random shuffle by successRate
    const selectedHigh = this.selectWebsitesDistributed(highTrafficWebsites, highTrafficTarget);
    const selectedLow = this.selectWebsitesDistributed(lowTrafficWebsites, lowTrafficTarget);

    // Combine
    const allSelected = [
      ...selectedHigh.map((w) => ({ ...w, trafficType: TrafficType.HIGH })),
      ...selectedLow.map((w) => ({ ...w, trafficType: TrafficType.LOW })),
    ];

    if (allSelected.length > 0) {
      // For accountType=multiple, apply Gmail dot trick to generate unique email per item
      const shouldApplyDotTrick =
        linkData.accountType === 'multiple' &&
        typeof linkData.email === 'string' &&
        linkData.email.includes('@');

      let emailDotCount = 0;
      if (shouldApplyDotTrick) {
        emailDotCount = await this.getEmailDotCount();
      }

      await tx.allocationItem.createMany({
        data: allSelected.map((w) => {
          let itemLinkData = linkData;
          if (shouldApplyDotTrick && emailDotCount > 0) {
            itemLinkData = {
              ...linkData,
              email: this.modifyEmailWithDots(linkData.email as string, emailDotCount),
            };
          }
          return {
            batchId,
            requestId,
            websiteId: w.id,
            domain: w.domain,
            serviceType,
            trafficType: w.trafficType,
            priorityScore: w.successRate,
            status: AllocationItemStatus.NEW,
            claimTimeout,
            linkData: itemLinkData as Prisma.InputJsonValue,
          };
        }),
      });

      await this.batchUpsertDailyAllocations(tx, allSelected.map((w) => w.id), today);

      // Invalidate website cache since daily allocations changed
      this.websiteCache.data = null;
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
   * Select websites using Round-Robin + Weighted Random distribution
   *
   * Algorithm:
   * 1. Group websites by dailyCount (0, 1, 2)
   * 2. Process groups from lowest dailyCount first (round-robin: least-used first)
   * 3. Within each group, use weighted random selection based on successRate
   *    â†’ websites with higher successRate have higher chance but are NOT guaranteed
   * 4. Stop when we have enough websites or run out of candidates
   *
   * This ensures:
   * - Websites with fewer daily allocations are prioritized (even distribution across requests)
   * - Within the same usage tier, selection is randomized (avoids same top-N every time)
   * - Higher successRate still gives an advantage (weighted, not pure random)
   */
  private selectWebsitesDistributed(
    websites: WebsiteForAllocation[],
    target: number
  ): WebsiteForAllocation[] {
    if (websites.length <= target) return [...websites];
    if (target <= 0) return [];

    // Group by dailyCount
    const groups = new Map<number, WebsiteForAllocation[]>();
    for (const w of websites) {
      const group = groups.get(w.dailyCount) || [];
      group.push(w);
      groups.set(w.dailyCount, group);
    }

    // Sort group keys ascending (0, 1, 2) â†’ least allocated first
    const sortedKeys = [...groups.keys()].sort((a, b) => a - b);

    const selected: WebsiteForAllocation[] = [];

    for (const key of sortedKeys) {
      if (selected.length >= target) break;

      const group = groups.get(key)!;
      const remaining = target - selected.length;

      if (group.length <= remaining) {
        // Take all from this group
        selected.push(...group);
      } else {
        // Weighted random selection from this group
        const picked = this.weightedRandomPick(group, remaining);
        selected.push(...picked);
      }
    }

    return selected;
  }

  /**
   * Weighted random pick: select `count` items from `pool`
   * Weight = successRate + 1 (add 1 so websites with 0% still have a chance)
   * Uses Fisher-Yates-like weighted sampling without replacement
   */
  private weightedRandomPick(
    pool: WebsiteForAllocation[],
    count: number
  ): WebsiteForAllocation[] {
    const candidates = [...pool];
    const result: WebsiteForAllocation[] = [];

    for (let i = 0; i < count && candidates.length > 0; i++) {
      // Calculate total weight
      const totalWeight = candidates.reduce((sum, w) => sum + w.successRate + 1, 0);

      // Pick random weighted index
      let rand = Math.random() * totalWeight;
      let pickedIdx = 0;
      for (let j = 0; j < candidates.length; j++) {
        rand -= candidates[j].successRate + 1;
        if (rand <= 0) {
          pickedIdx = j;
          break;
        }
      }

      // Move picked item to result, remove from candidates
      result.push(candidates[pickedIdx]);
      candidates.splice(pickedIdx, 1);
    }

    return result;
  }

  /**
   * Get available websites - OPTIMIZED with caching and parallel queries
   */
  private async getAvailableWebsitesOptimized(
    date: Date,
    serviceType?: ServiceType
  ): Promise<WebsiteForAllocation[]> {
    const now = Date.now();

    // Check cache (invalidate if serviceType changed)
    if (
      this.websiteCache.data &&
      this.websiteCache.expiresAt > now &&
      this.websiteCache.serviceType === serviceType
    ) {
      return this.websiteCache.data;
    }

    // Map serviceType to WebsiteType
    const typeFilter = serviceType ? this.mapServiceTypeToWebsiteType(serviceType) : undefined;

    // Build where clause
    const whereClause: Prisma.WebsiteWhereInput = {
      status: WebsiteStatus.RUNNING,
      deletedAt: null,
    };
    if (typeFilter) {
      whereClause.types = { has: typeFilter as WebsiteType };
    }

    // OPTIMIZATION: Run base queries in parallel
    const [websites, dailyAllocations] = await Promise.all([
      // Query 1: Get websites
      this.prisma.website.findMany({
        where: whereClause,
        select: { id: true, domain: true, metrics: true },
      }),
      // Query 2: Get daily allocations for today
      this.prisma.dailyAllocation.findMany({
        where: { date },
        select: { websiteId: true, allocationCount: true },
      }),
    ]);

    // Build lookup maps
    const allocationMap = new Map(dailyAllocations.map((d) => [d.websiteId, d.allocationCount]));

    // Use daily_allocations as the single source of truth for success rate.
    const websiteIds = websites.map((w) => w.id);
    const allocationHistory = websiteIds.length > 0
      ? await this.prisma.dailyAllocation.groupBy({
          by: ['websiteId'],
          where: { websiteId: { in: websiteIds } },
          _sum: {
            allocationCount: true,
            successCount: true,
          },
        })
      : [];
    const statsMap = new Map(
      allocationHistory.map((row) => {
        const allocations = row._sum.allocationCount || 0;
        const success = row._sum.successCount || 0;
        const successRate = allocations > 0
          ? Math.round((success / allocations) * 100 * 100) / 100
          : 0;
        return [row.websiteId, successRate] as const;
      })
    );

    // Filter and transform
    const result = websites
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
          successRate: statsMap.get(w.id) || 0,
          dailyCount: allocationMap.get(w.id) || 0,
        };
      });

    // Update cache
    this.websiteCache = {
      data: result,
      expiresAt: now + WEBSITE_CACHE_TTL_MS,
      serviceType,
    };

    return result;
  }

  /**
   * Batch upsert daily allocations using raw SQL for better performance
   * Uses UNNEST for safe parameterized batch insert
   */
  private async batchUpsertDailyAllocations(
    tx: Prisma.TransactionClient,
    websiteIds: string[],
    date: Date
  ): Promise<void> {
    await this.allocationMetrics.incrementAttempts(tx, websiteIds, date);
  }

  /**
   * Map ServiceType to WebsiteType
   */
  private mapServiceTypeToWebsiteType(serviceType: ServiceType): string {
    const mapping: Record<ServiceType, string> = {
      [ServiceType.ENTITY]: 'ENTITY',
      [ServiceType.BLOG2]: 'BLOG2',
      [ServiceType.SOCIAL]: 'SOCIAL',
      [ServiceType.PODCAST]: 'PODCAST',
      [ServiceType.GG_STACKING]: 'GG_STACKING',
    };
    return mapping[serviceType] || 'ENTITY';
  }

  // ==================== TOOL CLAIM API (OPTIMIZED) ====================

  /**
   * Tool claims pending tasks - OPTIMIZED with row-level locking
   *
   * Uses SELECT ... FOR UPDATE SKIP LOCKED to:
   * 1. Lock rows atomically - prevents race conditions
   * 2. SKIP LOCKED - if another thread locked the row, skip it instead of waiting
   * 3. Single atomic UPDATE - claim and update in one query
   *
   * Status flow:
   * - NEW tasks â†’ REGISTERING (tool will do registration/profiling)
   * - CONNECTING tasks â†’ CONNECTING (tool will do stacking, status remains CONNECTING)
   *
   * Tool type logic (from tools table):
   * - GLOBAL: Claim all available tasks (idTool is NULL or matches toolId)
   * - INDIVIDUAL: Only claim tasks where request.idTool matches this toolId exactly
   *
   * @param toolId - ID of the tool claiming tasks (idTool in tools table)
   * @param serviceType - Optional filter by service type
   * @param limit - Maximum number of tasks to claim (default 10)
   * @param supportedDomains - Optional array of domains the tool can handle
   * @param includeConnecting - If true, also claim CONNECTING tasks for stacking (default false)
   */
  async claimTasks(
    toolId: string,
    serviceType?: ServiceType,
    limit: number = 10,
    supportedDomains?: string[],
    includeConnecting: boolean = false
  ): Promise<ClaimResult> {
    // Get claim timeout config (cached)
    const claimTimeout = await this.getClaimTimeout();

    // Lookup tool type from tools table
    // - GLOBAL: can claim all tasks (idTool is NULL or matches)
    // - INDIVIDUAL: only claim tasks where request.idTool matches exactly
    const tool = await this.prisma.tool.findFirst({
      where: {
        idTool: toolId,
        deletedAt: null,
      },
      select: { type: true },
    });

    // Default to GLOBAL if tool not found (backward compatibility)
    const toolType = tool?.type || 'GLOBAL';

    // Build WHERE conditions for raw SQL
    // Include CONNECTING tasks if requested (for stacking phase)
    // Status flow for stacking:
    // - CONNECT: Waiting for threshold (all/limit mode) - NOT claimable
    // - CONNECTING: Ready for stacking (custom mode, or threshold met) - claimable
    // CONNECTING items must have claimedBy IS NULL to prevent duplicate claims
    // (after a tool claims CONNECTING, status stays CONNECTING but claimedBy is set)
    // Cast status values to AllocationItemStatus enum for PostgreSQL
    const statusCondition = includeConnecting
      ? `(ai.status = 'CONNECTING'::"AllocationItemStatus" AND ai."claimedBy" IS NULL)`
      : `ai.status = 'NEW'::"AllocationItemStatus"`;
    const conditions: string[] = [statusCondition];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Filter by serviceType (cast to enum type for PostgreSQL)
    if (serviceType) {
      conditions.push(`ai."serviceType" = $${paramIndex}::"ServiceType"`);
      params.push(serviceType);
      paramIndex++;
    }

    // Filter by supportedDomains
    if (supportedDomains && supportedDomains.length > 0) {
      const placeholders = supportedDomains.map((_, i) => `$${paramIndex + i}`).join(', ');
      conditions.push(`ai.domain IN (${placeholders})`);
      params.push(...supportedDomains);
      paramIndex += supportedDomains.length;
    }

    // Filter by toolId match based on tool type from database
    // request.idTool format: "Normal 1;Captcha 1" (multiple tools separated by ;)
    // toolId from request: "Normal 1" or "Captcha 1" (single tool)
    //
    // - GLOBAL: Claim tasks where idTool is NULL OR contains this toolId
    // - INDIVIDUAL: Only claim tasks where idTool contains this toolId
    //
    // Check if toolId is contained in idTool (with proper boundary check):
    // - idTool = toolId (exact match, single tool)
    // - idTool LIKE 'toolId;%' (at start)
    // - idTool LIKE '%;toolId' (at end)
    // - idTool LIKE '%;toolId;%' (in middle)
    //
    // We need separate params for each LIKE pattern
    const toolIdMatchCondition = `(
      sr."idTool" = $${paramIndex}
      OR sr."idTool" LIKE $${paramIndex + 1}
      OR sr."idTool" LIKE $${paramIndex + 2}
      OR sr."idTool" LIKE $${paramIndex + 3}
    )`;

    if (toolType === 'INDIVIDUAL') {
      conditions.push(toolIdMatchCondition);
    } else {
      // GLOBAL (or other types): can claim unassigned tasks OR tasks assigned to this tool
      conditions.push(`(sr."idTool" IS NULL OR ${toolIdMatchCondition})`);
    }
    // Push 4 params: exact match, start pattern, end pattern, middle pattern
    params.push(toolId);                    // exact match
    params.push(`${toolId};%`);             // at start: "Normal 1;%"
    params.push(`%;${toolId}`);             // at end: "%;Normal 1"
    params.push(`%;${toolId};%`);           // in middle: "%;Normal 1;%"
    paramIndex += 4;

    // Add limit and other params
    params.push(limit); // $paramIndex for LIMIT
    const limitParamIndex = paramIndex;
    paramIndex++;

    params.push(toolId); // for UPDATE SET claimedBy
    const toolIdUpdateIndex = paramIndex;
    paramIndex++;

    params.push(claimTimeout); // for UPDATE SET claimTimeout
    const timeoutParamIndex = paramIndex;

    const whereClause = conditions.join(' AND ');

    try {
      // Single atomic query: SELECT FOR UPDATE SKIP LOCKED + UPDATE + RETURNING
      // This prevents race conditions completely
      const claimedItems = await this.prisma.$queryRawUnsafe<Array<{
        id: string;
        domain: string;
        serviceType: ServiceType;
        linkData: unknown;
        linkProfile: string | null;
        linkPost: string | null;
        requestId: string | null;
        previousStatus: string;
      }>>(
        `
        WITH locked_items AS (
          SELECT ai.id, ai.status as prev_status
          FROM allocation_items ai
          INNER JOIN allocation_batches ab ON ab.id = ai."batchId"
          INNER JOIN service_requests sr ON sr.id = ab."requestId"
          WHERE ${whereClause}
          ORDER BY ai."priorityScore" DESC, ai."allocatedAt" ASC
          LIMIT $${limitParamIndex}
          FOR UPDATE OF ai SKIP LOCKED
        ),
        updated AS (
          UPDATE allocation_items ai
          SET
            -- NEW tasks â†’ REGISTERING, CONNECTING tasks stay CONNECTING (for stacking)
            -- Cast to AllocationItemStatus enum for PostgreSQL
            status = CASE
              WHEN li.prev_status = 'CONNECTING'::"AllocationItemStatus" THEN 'CONNECTING'::"AllocationItemStatus"
              ELSE 'REGISTERING'::"AllocationItemStatus"
            END,
            "claimedBy" = $${toolIdUpdateIndex},
            "claimedAt" = NOW(),
            "claimTimeout" = $${timeoutParamIndex}
          FROM locked_items li
          WHERE ai.id = li.id
          RETURNING ai.id, ai.domain, ai."serviceType", ai."linkData", ai."linkProfile", ai."linkPost", ai."requestId", li.prev_status
        )
        SELECT
          id,
          domain,
          "serviceType" as "serviceType",
          "linkData" as "linkData",
          "linkProfile" as "linkProfile",
          "linkPost" as "linkPost",
          "requestId" as "requestId",
          prev_status as "previousStatus"
        FROM updated
        `,
        ...params
      );

      if (claimedItems.length === 0) {
        return { success: true, items: [], message: 'No pending tasks available' };
      }

      // Update request statuses to RUNNING (non-blocking, fire and forget)
      const requestIds = [...new Set(claimedItems.map((i) => i.requestId).filter((id): id is string => id !== null))];
      if (requestIds.length > 0) {
        this.prisma.serviceRequest.updateMany({
          where: {
            id: { in: requestIds },
            status: RequestStatus.PENDING,
          },
          data: { status: RequestStatus.RUNNING },
        }).catch((err) => {
          this.fastify.log.warn({ err, requestIds }, 'Failed to update request status to RUNNING');
        });
      }

      return {
        success: true,
        items: claimedItems.map((i) => ({
          id: i.id,
          domain: i.domain,
          serviceType: i.serviceType,
          linkData: i.linkData,
          linkProfile: i.linkProfile,
          linkPost: i.linkPost,
          requestId: i.requestId,
        })),
      };
    } catch (error) {
      this.fastify.log.error({
        toolId,
        toolType,
        serviceType,
        limit,
        includeConnecting,
        err: error,
      }, 'Failed to claim tasks');
      return { success: false, items: [], message: 'Failed to claim tasks' };
    }
  }

  /**
   * Release expired claims - OPTIMIZED with raw SQL
   * - Items with retryIndex < 3: Reset to NEW, increment retryIndex
   * - Items with retryIndex >= 3: Mark as FAILED (max retries exceeded)
   */
  async releaseExpiredClaims(): Promise<number> {
    return this.releaseExpiredClaimsUseCase.execute();
  }

  // ==================== REQUEST TIMEOUT ====================

  /**
   * Timeout expired requests
   * - Find RUNNING requests that exceeded their completion time
   * - Mark request as COMPLETED
   * - Cancel all pending/processing allocation items
   *
   * Timeout calculation:
   * - entityLimit >= 100: timeout = (entityLimit / 100) * completionTimePer100
   * - entityLimit < 100: timeout = 30 minutes (fixed)
   *
   * Note: Timeout is calculated from the earliest claimedAt of allocation items,
   * which represents when a tool actually started processing (not batch.createdAt
   * which is when allocation happened). This prevents requests from timing out
   * while still waiting in queue for tools to pick them up.
   *
   * If no items have been claimed yet, the request is skipped (still waiting for tools).
   */
  async timeoutExpiredRequests(): Promise<{ timedOut: number; cancelledItems: number }> {
    return this.timeoutExpiredRequestsUseCase.execute(
      () => this.getRequestCompletionTimePer100(),
      (entityLimit, completionTimePer100) =>
        this.calculateRequestTimeout(entityLimit, completionTimePer100)
    );
  }

  /**
   * Update task status directly - for flexible status updates
   *
   * Allows updating to any valid AllocationItemStatus
   * Supports updating: linkProfile, linkPost, note, errorCode, errorMessage,
   * linkData (MERGE), claimedBy, claimedAt, claimTimeout, retryIndex, linkStatus, externalLinkId
   *
   * For linkData: Uses MERGE behavior - only updates specified keys, keeps existing keys intact
   * Example: {"linkData": {"username": "new"}} only updates username in existing linkData
   */
  async updateTaskStatus(
    itemId: string,
    data: {
      status: AllocationItemStatus;
      linkProfile?: string;
      linkPost?: string;
      note?: string;
      errorCode?: string;
      errorMessage?: string;
      // Extended fields
      linkData?: Record<string, unknown>; // Will be MERGED with existing linkData
      claimedBy?: string;
      claimedAt?: string | null; // ISO date string or null to clear
      claimTimeout?: number;
      retryIndex?: number;
      linkStatus?: string;
      externalLinkId?: string;
    }
  ): Promise<{ success: boolean; message?: string; item?: unknown }> {
    const result = await this.prisma.$transaction(async (tx) => {
      // Find the item first with batch to get requestId and existing linkData for merge
      const item = await tx.allocationItem.findUnique({
        where: { id: itemId },
        select: {
          id: true,
          status: true,
          websiteId: true,
          allocatedAt: true,
          completedAt: true,
          linkProfile: true,
          linkData: true,
          batch: { select: { requestId: true } },
        },
      });

      if (!item) {
        return { success: false, message: 'Task not found' };
      }

      // Build update data
      const updateData: Record<string, unknown> = {
        status: data.status,
      };

      if (data.linkProfile !== undefined) {
        updateData.linkProfile = data.linkProfile;
      }
      if (data.linkPost !== undefined) {
        updateData.linkPost = data.linkPost;
      }
      if (data.note !== undefined) {
        updateData.note = data.note;
      }
      if (data.errorCode !== undefined) {
        updateData.errorCode = data.errorCode;
      }
      if (data.errorMessage !== undefined) {
        updateData.errorMessage = data.errorMessage;
      }

      // Extended fields
      if (data.linkData !== undefined) {
        // MERGE behavior: only update specified keys, keep existing keys
        const existingLinkData = (item.linkData as Record<string, unknown>) || {};
        updateData.linkData = { ...existingLinkData, ...data.linkData };
      }
      if (data.claimedBy !== undefined) {
        updateData.claimedBy = data.claimedBy;
      }
      if (data.claimedAt !== undefined) {
        // claimedAt can be null to clear, or ISO date string
        updateData.claimedAt = data.claimedAt === null ? null : new Date(data.claimedAt);
      }
      if (data.claimTimeout !== undefined) {
        updateData.claimTimeout = data.claimTimeout;
      }
      if (data.retryIndex !== undefined) {
        updateData.retryIndex = data.retryIndex;
      }
      if (data.linkStatus !== undefined) {
        updateData.linkStatus = data.linkStatus;
      }
      if (data.externalLinkId !== undefined) {
        updateData.externalLinkId = data.externalLinkId;
      }

      // Set completedAt if status is terminal
      if (TERMINAL_STATUSES.includes(data.status)) {
        updateData.completedAt = new Date();
      }

      // Update the item
      const updated = await tx.allocationItem.update({
        where: { id: itemId },
        data: updateData,
        select: {
          id: true,
          status: true,
          domain: true,
          linkProfile: true,
          linkPost: true,
          linkData: true,
          note: true,
          errorCode: true,
          errorMessage: true,
          claimedBy: true,
          claimedAt: true,
          claimTimeout: true,
          retryIndex: true,
          linkStatus: true,
          externalLinkId: true,
        },
      });

      this.fastify.log.info({
        itemId,
        oldStatus: item.status,
        newStatus: data.status,
        linkDataMerged: data.linkData !== undefined,
      }, 'Task status updated directly');

      const requestId = item.batch?.requestId;
      const shouldCountResult =
        TERMINAL_STATUSES.includes(data.status) && shouldCountOnce(item.completedAt);
      const effectiveLinkProfile =
        data.linkProfile !== undefined ? data.linkProfile : item.linkProfile;
      const hasLinkProfile = isSuccessByProfile(effectiveLinkProfile);

      // Sync counters/stats for terminal transitions (count exactly once per item)
      if (requestId && shouldCountResult) {
        await this.allocationMetrics.recordTerminalResult(tx, {
          requestId,
          websiteId: item.websiteId,
          allocatedAt: item.allocatedAt,
          prevStatus: item.status,
          nextStatus: data.status,
          errorCode: data.errorCode,
          isSuccess: hasLinkProfile,
        });
      }

      // If status changed to terminal, update request progress in same transaction
      if (TERMINAL_STATUSES.includes(data.status) && requestId) {
        await this.updateRequestProgressOptimized(tx, requestId);
      }

      return { success: true, item: updated };
    });

    return result;
  }

  /**
   * Complete a claimed task - OPTIMIZED with single transaction
   *
   * Status determination logic when task has linkProfile (profiling step completed):
   * - If request.status is RUNNING or COMPLETED AND entityConnect !== 'disable'
   *   â†’ Set task status to CONNECTING (tool will claim again for stacking)
   * - Otherwise â†’ Set task status to FINISH
   *
   * This allows tasks to go through stacking phase based on entityConnect config
   */
  async completeTask(
    itemId: string,
    result: {
      success: boolean;
      linkProfile?: string;
      linkPost?: string;
      errorCode?: string;
      errorMessage?: string;
    }
  ): Promise<{ success: boolean; message?: string }> {
    return this.completeTaskUseCase.execute(
      itemId,
      result,
      (tx, requestId) => this.updateRequestProgressOptimized(tx, requestId)
    );
  }

  /**
   * Update request progress - OPTIMIZED
   *
   * Also auto-cancels remaining NEW items when completedLinks >= completionTarget.
   * completionTarget = entityLimit * COMPLETION_THRESHOLD_PERCENT / 100 (configurable).
   * Tools that are already processing (REGISTERING, PROFILING, CONNECTING) will
   * finish their current work, but no new items will be claimed.
   */
  private async updateRequestProgressOptimized(
    tx: Prisma.TransactionClient,
    requestId: string
  ): Promise<void> {
    const request = await tx.serviceRequest.findUnique({
      where: { id: requestId },
      select: { totalLinks: true, completedLinks: true, failedLinks: true, config: true },
    });

    if (!request) return;

    let total = request.totalLinks;
    const completed = request.completedLinks + request.failedLinks;
    let progressPercent = total > 0 ? Math.min(100, (completed / total) * 100) : 0;

    const updateData: Prisma.ServiceRequestUpdateInput = { progressPercent };

    // Check if request is complete
    if (completed >= total && progressPercent >= 100) {
      updateData.status = RequestStatus.COMPLETED;
    }

    // Auto-cancel NEW items when completedLinks reaches completion target (configurable threshold)
    // Tools already processing (REGISTERING, PROFILING, CONNECTING) will finish their work
    const config = request.config as Record<string, unknown> | null;
    const entityLimit = (config?.entityLimit as number) || 100;
    const thresholdPercent = await this.getCompletionThresholdPercent();
    const completionTarget = this.getCompletionTarget(entityLimit, thresholdPercent);

    if (request.completedLinks >= completionTarget) {
      const cancelMessage = `Request reached target (${request.completedLinks}/${completionTarget})`;
      const cancelledRows = await tx.$queryRaw<Array<{ cancelledCount: bigint }>>`
        WITH cancelled AS (
          UPDATE allocation_items ai
          SET
            status = 'CANCEL'::"AllocationItemStatus",
            "errorCode" = 'TARGET_REACHED',
            "errorMessage" = ${cancelMessage},
            "completedAt" = NOW()
          WHERE
            ai."requestId" = ${requestId}
            AND ai.status = 'NEW'::"AllocationItemStatus"
            AND ai."completedAt" IS NULL
          RETURNING ai."websiteId", DATE(ai."allocatedAt") AS alloc_date
        ),
        agg AS (
          SELECT "websiteId", alloc_date, COUNT(*)::int AS cnt
          FROM cancelled
          GROUP BY "websiteId", alloc_date
        ),
        updated_allocations AS (
          UPDATE daily_allocations da
          SET
            "allocationCount" = GREATEST(0, da."allocationCount" - agg.cnt),
            "updatedAt" = NOW()
          FROM agg
          WHERE
            da."websiteId" = agg."websiteId"
            AND da.date = agg.alloc_date
          RETURNING 1
        )
        SELECT COUNT(*)::bigint AS "cancelledCount"
        FROM cancelled
      `;

      const cancelledCount = Number(cancelledRows[0]?.cancelledCount || 0);

      if (cancelledCount > 0) {
        // Adjust totalLinks down so progress percent stays accurate
        updateData.totalLinks = { decrement: cancelledCount };
        total = Math.max(0, total - cancelledCount);
        progressPercent = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
        updateData.progressPercent = progressPercent;
        if (completed >= total && progressPercent >= 100) {
          updateData.status = RequestStatus.COMPLETED;
        }
        this.fastify.log.info({
          requestId,
          completedLinks: request.completedLinks,
          completionTarget,
          entityLimit,
          thresholdPercent,
          cancelledNewItems: cancelledCount,
        }, `Auto-cancelled ${cancelledCount} NEW items - target reached`);
      }
    }

    await tx.serviceRequest.update({
      where: { id: requestId },
      data: updateData,
    });
  }

  // ==================== MYSQL SYNC ====================

  /**
   * Sync allocated websites to MySQL (legacy support)
   * Called after transaction commits
   */
  async syncToMySQL(
    request: ServiceRequest,
    websites: Array<{ websiteId: string; domain: string; trafficType: TrafficType }>
  ): Promise<void> {
    if (!this.mysqlRepo) return;

    const config = request.config as Record<string, unknown> | null;

    try {
      switch (request.serviceType) {
        case ServiceType.ENTITY:
          const entityLinks = websites.map((w) => ({
            entityRequestId: request.externalId ? Number(request.externalId) : 0,
            email: (config?.email as string) || '',
            username: (config?.username as string) || '',
            about: (config?.about as string) || null,
            site: w.domain,
            accountType: (config?.accountType as string) || 'normal',
            trafficType: w.trafficType === TrafficType.HIGH ? 'normal' as const : 'captcha' as const,
          }));
          await this.mysqlRepo.entityLink.insertMany(entityLinks);
          break;
        default:
          this.fastify.log.debug(
            { serviceType: request.serviceType },
            'No MySQL sync for this service type'
          );
      }
    } catch (error) {
      this.fastify.log.error({ err: error, requestId: request.id }, 'Failed to sync to MySQL');
    }
  }

  // ==================== ALERTS ====================

  /**
   * Create a system alert - fire and forget
   */
  createAlert(params: {
    type: AlertType;
    severity: AlertSeverity;
    title: string;
    message: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    // Fire and forget - don't await
    return this.prisma.systemAlert.create({
      data: {
        type: params.type,
        severity: params.severity,
        title: params.title,
        message: params.message,
        entityType: params.entityType,
        entityId: params.entityId,
        metadata: params.metadata as Prisma.InputJsonValue,
      },
    }).then(() => { }).catch((error) => {
      this.fastify.log.error({ error, params }, 'Failed to create alert');
    });
  }

  // ==================== STATISTICS (OPTIMIZED) ====================

  /**
   * Get allocation statistics - OPTIMIZED with parallel queries
   */
  async getStatistics(): Promise<{
    todayAllocations: number;
    todaySuccess: number;
    todayFailure: number;
    pendingItems: number;
    processingItems: number;
    claimedItems: number;
    waitingStackingItems: number;
    pendingRequests: number;
    runningRequests: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Run all queries in parallel
    const [dailyStats, itemStats, requestStats] = await Promise.all([
      this.prisma.dailyAllocation.aggregate({
        where: { date: today },
        _sum: { allocationCount: true, successCount: true, failureCount: true },
      }),
      this.prisma.allocationItem.groupBy({
        by: ['status'],
        where: {
          status: {
            in: [
              AllocationItemStatus.NEW,
              AllocationItemStatus.REGISTERING,
              AllocationItemStatus.PROFILING,
              'CONNECT' as AllocationItemStatus, // Newly added status
              AllocationItemStatus.CONNECTING,
            ],
          },
        },
        _count: { _all: true },
      }),
      this.prisma.serviceRequest.groupBy({
        by: ['status'],
        where: { status: { in: [RequestStatus.PENDING, RequestStatus.RUNNING] }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    const itemStatMap = new Map(itemStats.map((s) => [s.status, s._count._all]));
    const requestStatMap = new Map(requestStats.map((s) => [s.status, s._count._all]));

    // Count NEW items (waiting for tools to claim)
    const pendingItems = itemStatMap.get(AllocationItemStatus.NEW) || 0;

    // Count CONNECT items (waiting for stacking threshold)
    const waitingStackingItems = itemStatMap.get('CONNECT' as AllocationItemStatus) || 0;

    // Count processing items (REGISTERING + PROFILING + CONNECTING)
    const processingItems =
      (itemStatMap.get(AllocationItemStatus.REGISTERING) || 0) +
      (itemStatMap.get(AllocationItemStatus.PROFILING) || 0) +
      (itemStatMap.get(AllocationItemStatus.CONNECTING) || 0);

    return {
      todayAllocations: dailyStats._sum.allocationCount || 0,
      todaySuccess: dailyStats._sum.successCount || 0,
      todayFailure: dailyStats._sum.failureCount || 0,
      pendingItems,
      processingItems,
      claimedItems: processingItems, // Backward compatible alias
      waitingStackingItems,
      pendingRequests: requestStatMap.get(RequestStatus.PENDING) || 0,
      runningRequests: requestStatMap.get(RequestStatus.RUNNING) || 0,
    };
  }

  /**
   * Get pending tasks for a specific tool - OPTIMIZED
   */
  async getPendingTasksForTool(
    toolId: string,
    serviceType?: ServiceType
  ): Promise<{
    count: number;
    items: Array<{
      id: string;
      domain: string;
      serviceType: ServiceType;
      allocatedAt: Date;
    }>;
  }> {
    // Use count + limited items to avoid fetching too much data
    const [count, items] = await Promise.all([
      this.prisma.allocationItem.count({
        where: {
          status: AllocationItemStatus.NEW,
          ...(serviceType && { serviceType }),
          batch: {
            request: {
              OR: [{ idTool: null }, { idTool: toolId }],
            },
          },
        },
      }),
      this.prisma.allocationItem.findMany({
        where: {
          status: AllocationItemStatus.NEW,
          ...(serviceType && { serviceType }),
          batch: {
            request: {
              OR: [{ idTool: null }, { idTool: toolId }],
            },
          },
        },
        select: { id: true, domain: true, serviceType: true, allocatedAt: true },
        orderBy: { allocatedAt: 'asc' },
        take: 100, // Limit to prevent large response
      }),
    ]);

    return { count, items };
  }

  // ==================== LINK PROFILE QUERIES ====================

  /**
   * Get linkProfile list for a request, excluding a specific item
   *
   * Equivalent to MySQL:
   * SELECT link_profile FROM entity_link
   * WHERE entityRequestId = :requestId
   *   AND link_profile != ''
   *   AND id != :excludeItemId
   */
  async getLinkProfilesByRequest(
    requestId: string,
    excludeItemId: string,
    limit?: number
  ): Promise<{ success: boolean; linkProfiles: string[]; count: number }> {
    const items = await this.prisma.allocationItem.findMany({
      where: {
        requestId,
        id: { not: excludeItemId },
        linkProfile: { not: null },
      },
      select: {
        linkProfile: true,
      },
      ...(limit && { take: limit }),
    });

    // Filter out empty strings
    const linkProfiles = items
      .map((i) => i.linkProfile!)
      .filter((lp) => lp !== '');

    return {
      success: true,
      linkProfiles,
      count: linkProfiles.length,
    };
  }

  // ==================== PUBLIC API METHODS ====================

  /**
   * Allocate for request (public API)
   */
  async allocateForRequest(request: ServiceRequest): Promise<AllocationResult> {
    const [multiplier, claimTimeout] = await Promise.all([
      this.getAllocationMultiplier(),
      this.getClaimTimeout(),
    ]);
    return this.allocateForRequestOptimized(request, multiplier, claimTimeout);
  }

  /**
   * Update daily allocations (public API)
   */
  async updateDailyAllocations(websiteIds: string[], date: Date): Promise<void> {
    if (websiteIds.length === 0) return;
    await this.batchUpsertDailyAllocations(this.prisma, websiteIds, date);
  }

  // ==================== STACKING READINESS (MONITOR JOB) ====================

  /**
   * Trigger stacking for requests that have reached their threshold
   *
   * Called by Monitor Service periodically to check:
   * - Requests with entityConnect = 'all': Check if linkProfile count >= entityLimit
   * - Requests with entityConnect = 'limit': Check if linkProfile count >= limit value in config
   *
   * When threshold is met, change status from CONNECT â†’ CONNECTING
   * so tasks can be claimed by tools for stacking phase.
   *
   * Status flow:
   * - CONNECT: Waiting for threshold (not claimable)
   * - CONNECTING: Ready for stacking (claimable by tools)
   *
   * @returns Number of requests that were triggered for stacking
   */
  async triggerStackingForReadyRequests(): Promise<{
    triggered: number;
    updatedItems: number;
    details: Array<{
      requestId: string;
      entityConnect: string;
      threshold: number;
      linkProfileCount: number;
    }>;
  }> {
    let triggered = 0;
    let updatedItems = 0;
    const details: Array<{
      requestId: string;
      entityConnect: string;
      threshold: number;
      linkProfileCount: number;
    }> = [];

    // Find RUNNING/COMPLETED requests that have CONNECT tasks (waiting for threshold)
    // These are requests with entityConnect = 'all' or 'limit'
    const requestsWithPendingStacking = await this.prisma.$queryRaw<Array<{
      requestId: string;
      config: unknown;
      pendingStackingCount: bigint;
    }>>`
      SELECT DISTINCT
        sr.id as "requestId",
        sr.config,
        COUNT(ai.id) as "pendingStackingCount"
      FROM service_requests sr
      INNER JOIN allocation_batches ab ON ab."requestId" = sr.id
      INNER JOIN allocation_items ai ON ai."batchId" = ab.id
      WHERE sr.status IN ('RUNNING', 'COMPLETED')
        AND sr."deletedAt" IS NULL
        AND ai.status = 'CONNECT'
      GROUP BY sr.id, sr.config
      HAVING COUNT(ai.id) > 0
    `;

    if (requestsWithPendingStacking.length === 0) {
      return { triggered: 0, updatedItems: 0, details: [] };
    }

    for (const row of requestsWithPendingStacking) {
      const config = row.config as Record<string, unknown> | null;
      const entityConnect = (config?.entityConnect as string) || 'disable';

      // Skip if not 'all' or 'limit' (shouldn't happen, but safety check)
      if (entityConnect !== 'all' && entityConnect !== 'limit') {
        continue;
      }

      // Determine threshold based on entityConnect type
      let threshold: number;
      if (entityConnect === 'all') {
        // Wait until linkProfile count >= entityLimit
        threshold = (config?.entityLimit as number) || 100;
      } else {
        // entityConnect === 'limit'
        // Wait until linkProfile count >= limit value from config
        const limitValue = (config?.entityConnectLimit as number) || (config?.entityLimit as number) || 100;
        threshold = limitValue;
      }

      // Count tasks with linkProfile for this request
      const linkProfileCount = await this.prisma.allocationItem.count({
        where: {
          batch: { requestId: row.requestId },
          linkProfile: { not: null },
        },
      });

      // Check if threshold is met
      if (linkProfileCount >= threshold) {
        // Change status from CONNECT â†’ CONNECTING for all tasks of this request
        const updated = await this.prisma.$executeRaw`
          UPDATE allocation_items ai
          SET status = 'CONNECTING'
          FROM allocation_batches ab
          WHERE ai."batchId" = ab.id
            AND ab."requestId" = ${row.requestId}
            AND ai.status = 'CONNECT'
        `;

        if (updated > 0) {
          triggered++;
          updatedItems += updated;
          details.push({
            requestId: row.requestId,
            entityConnect,
            threshold,
            linkProfileCount,
          });

          this.fastify.log.info({
            requestId: row.requestId,
            entityConnect,
            threshold,
            linkProfileCount,
            updatedItems: updated,
          }, 'Triggered stacking for request - threshold reached, CONNECT â†’ CONNECTING');
        }
      }
    }

    if (triggered > 0) {
      this.fastify.log.info({ triggered, updatedItems }, 'Triggered stacking for ready requests');
    }

    return { triggered, updatedItems, details };
  }

  // ==================== AUTO-DETECT COMPLETED â†’ RE_RUN ====================

  /**
   * Check COMPLETED requests that haven't met their target and transition to RE_RUN
   *
   * Logic:
   * 1. Find COMPLETED requests where completedLinks < completionTarget
   * 2. If retryCount >= MAX_SUPPLEMENT_RETRIES (2) â†’ skip (already retried enough)
   * 3. Otherwise â†’ set status=RE_RUN, idTool=null, retryCount++
   * 4. autoAssignTools will then assign a RE_RUNNING tool pair
   * 5. processSupplementRequests will allocate deficit websites
   */
  async checkCompletedForReRun(): Promise<{
    transitioned: number;
    skipped: number;
    maxRetriesReached: number;
  }> {
    let transitioned = 0;
    let skipped = 0;
    let maxRetriesReached = 0;

    const thresholdPercent = await this.getCompletionThresholdPercent();

    // Find COMPLETED requests (not deleted)
    const completedRequests = await this.prisma.serviceRequest.findMany({
      where: {
        status: RequestStatus.COMPLETED,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });

    if (completedRequests.length === 0) {
      return { transitioned: 0, skipped: 0, maxRetriesReached: 0 };
    }

    for (const request of completedRequests) {
      const config = request.config as Record<string, unknown> | null;
      const entityLimit = (config?.entityLimit as number) || 100;
      const completionTarget = this.getCompletionTarget(entityLimit, thresholdPercent);

      // Check if target is met
      if (request.completedLinks >= completionTarget) {
        skipped++;
        continue;
      }

      // Check run count limit
      if (request.runCount >= MAX_SUPPLEMENT_RETRIES) {
        maxRetriesReached++;
        continue;
      }

      // Transition COMPLETED â†’ RE_RUN
      try {
        await this.prisma.serviceRequest.update({
          where: { id: request.id },
          data: {
            status: RequestStatus.RE_RUN,
            idTool: null, // Reset so autoAssignTools assigns a RE_RUNNING tool
            runCount: { increment: 1 },
            retryCount: { increment: 1 },
          },
        });

        transitioned++;
        this.fastify.log.info(
          {
            requestId: request.id,
            completedLinks: request.completedLinks,
            completionTarget,
            runCount: request.runCount + 1,
            retryCount: request.retryCount + 1,
          },
          `COMPLETED â†’ RE_RUN (retry ${request.retryCount + 1}/${MAX_SUPPLEMENT_RETRIES})`
        );
      } catch (error) {
        this.fastify.log.error(
          { err: error, requestId: request.id },
          'Failed to transition COMPLETED â†’ RE_RUN'
        );
      }
    }

    return { transitioned, skipped, maxRetriesReached };
  }

  // ==================== SUPPLEMENT REQUESTS (RE_RUN) ====================

  /**
   * Process RE_RUN requests and allocate websites for deficit
   * Similar to processNewRequests() but calculates deficit from completionTarget
   */
  async processSupplementRequests(): Promise<{
    processed: number;
    skipped: number;
    failed: number;
  }> {
    return this.supplementRequestsUseCase.execute({
      getAllocationMultiplier: () => this.getAllocationMultiplier(),
      getClaimTimeout: () => this.getClaimTimeout(),
      getCompletionThresholdPercent: () => this.getCompletionThresholdPercent(),
      getCompletionTarget: (entityLimit, thresholdPercent) =>
        this.getCompletionTarget(entityLimit, thresholdPercent),
      allocateForRequestOptimized: (
        request,
        multiplier,
        claimTimeout,
        overrideEntityLimit
      ) =>
        this.allocateForRequestOptimized(
          request,
          multiplier,
          claimTimeout,
          overrideEntityLimit
        ),
    });
  }

  // ==================== AUTO-ASSIGN TOOL PAIRS ====================

  /**
   * Map ServiceType (from ServiceRequest) to ToolService (from Tool)
   */
  private mapServiceTypeToToolService(serviceType: ServiceType): ToolService {
    const mapping: Record<ServiceType, ToolService> = {
      [ServiceType.ENTITY]: ToolService.ENTITY,
      [ServiceType.BLOG2]: ToolService.BLOG,
      [ServiceType.SOCIAL]: ToolService.SOCIAL,
      [ServiceType.PODCAST]: ToolService.PODCAST,
      [ServiceType.GG_STACKING]: ToolService.GOOGLE_STACKING,
    };
    return mapping[serviceType] || ToolService.ENTITY;
  }

  private async buildValidToolPairs(toolType: 'INDIVIDUAL' | 'RE_RUNNING'): Promise<ToolPairInfo[]> {
    const tools = await this.prisma.tool.findMany({
      where: {
        type: toolType,
        status: 'RUNNING',
        deletedAt: null,
      },
      select: {
        idTool: true,
        customerType: true,
        service: true,
      },
    });

    const pairMap = new Map<string, {
      normal: { idTool: string; customerType: string | null; service: ToolService } | null;
      captcha: { idTool: string; customerType: string | null; service: ToolService } | null;
    }>();

    for (const tool of tools) {
      const normalMatch = tool.idTool.match(/^Normal\s+(\d+)$/i);
      const captchaMatch = tool.idTool.match(/^Captcha\s+(\d+)$/i);

      if (normalMatch) {
        const pairNum = normalMatch[1];
        if (!pairMap.has(pairNum)) pairMap.set(pairNum, { normal: null, captcha: null });
        pairMap.get(pairNum)!.normal = tool;
      } else if (captchaMatch) {
        const pairNum = captchaMatch[1];
        if (!pairMap.has(pairNum)) pairMap.set(pairNum, { normal: null, captcha: null });
        pairMap.get(pairNum)!.captcha = tool;
      }
    }

    const validPairs: ToolPairInfo[] = [];
    for (const [pairNum, pair] of pairMap.entries()) {
      if (pair.normal && pair.captcha) {
        validPairs.push({
          pairNumber: pairNum,
          idToolValue: `${pair.normal.idTool};${pair.captcha.idTool}`,
          customerType: pair.normal.customerType || 'normal',
          service: pair.normal.service,
        });
      }
    }

    return validPairs;
  }

  private async buildLoadMapForPairs(
    pairs: ToolPairInfo[],
    statuses: RequestStatus[]
  ): Promise<Map<string, number>> {
    const loadMap = new Map<string, number>();
    for (const pair of pairs) {
      loadMap.set(pair.idToolValue, 0);
    }

    if (pairs.length === 0) {
      return loadMap;
    }

    const existingCounts = await this.prisma.serviceRequest.groupBy({
      by: ['idTool'],
      where: {
        idTool: { in: pairs.map((p) => p.idToolValue) },
        status: { in: statuses },
        deletedAt: null,
      },
      _count: { _all: true },
    });

    for (const row of existingCounts) {
      if (row.idTool) {
        loadMap.set(row.idTool, row._count._all);
      }
    }

    return loadMap;
  }

  private async applyAssignments(assignments: AssignmentDetail[]): Promise<{
    assigned: number;
    assignedDetails: AssignmentDetail[];
  }> {
    let assigned = 0;
    const assignedDetails: AssignmentDetail[] = [];

    for (const assignment of assignments) {
      try {
        await this.prisma.serviceRequest.update({
          where: {
            id: assignment.requestId,
            idTool: null,
          },
          data: { idTool: assignment.idTool },
        });
        assigned++;
        assignedDetails.push(assignment);
      } catch {
        this.fastify.log.debug(
          { requestId: assignment.requestId },
          'Failed to assign tool (likely already assigned)'
        );
      }
    }

    return { assigned, assignedDetails };
  }

  /**
   * Auto-assign idTool to NEW/PENDING service requests that don't have one.
   *
   * Algorithm:
   * 1. Find all valid tool pairs (both Normal X and Captcha X are RUNNING + INDIVIDUAL)
   * 2. Find all unassigned requests (idTool IS NULL, status IN (NEW, PENDING), deletedAt IS NULL)
   * 3. Group requests by priority: HIGH/URGENT first, then LOW/NORMAL
   * 4. Within each group, sort by auctionPrice DESC, then createdAt ASC
   * 5. Match tool pairs to requests based on customerType mapping:
   *    - customerType='priority' â†’ HIGH/URGENT requests
   *    - customerType='normal'/null â†’ LOW/NORMAL requests
   * 6. Round-robin distribute across available pairs for load balancing
   * 7. Update with optimistic lock (WHERE idTool IS NULL)
   */
  async autoAssignTools(): Promise<{
    assigned: number;
    skipped: number;
    details: Array<{
      requestId: string;
      idTool: string;
      priority: string;
      auctionPrice: string | null;
    }>;
  }> {
    // --- Phase 1: Find valid tool pairs ---
    const validPairs = await this.buildValidToolPairs('INDIVIDUAL');

    if (validPairs.length === 0) {
      return { assigned: 0, skipped: 0, details: [] };
    }

    // Separate pairs by customerType
    const priorityPairs = validPairs.filter((p) => p.customerType === 'priority');
    const normalPairs = validPairs.filter((p) => p.customerType !== 'priority');

    // --- Phase 2: Find unassigned requests + count existing load per pair ---

    // Build load map: idToolValue â†’ current active request count
    const loadMap = await this.buildLoadMapForPairs(validPairs, [
      RequestStatus.NEW,
      RequestStatus.PENDING,
      RequestStatus.RUNNING,
    ]);

    // Note: Not using `select` here because the Prisma client may not have
    // the `priority` field in its generated types yet (requires prisma generate).
    // Using full model avoids type issues while the field exists in the DB.
    const unassignedRequests = await this.prisma.serviceRequest.findMany({
      where: {
        idTool: null,
        status: { in: [RequestStatus.NEW, RequestStatus.PENDING] },
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    if (unassignedRequests.length === 0) {
      return { assigned: 0, skipped: 0, details: [] };
    }

    // --- Phase 3: Sort and group requests ---
    // Cast to access priority field (exists in DB after migration)
    type RequestWithPriority = (typeof unassignedRequests)[0] & { priority: string };
    const requests = unassignedRequests as RequestWithPriority[];

    const priorityRequests = requests
      .filter((r) => r.priority === 'HIGH' || r.priority === 'URGENT')
      .sort((a, b) => {
        const priceA = a.auctionPrice ? Number(a.auctionPrice) : 0;
        const priceB = b.auctionPrice ? Number(b.auctionPrice) : 0;
        if (priceB !== priceA) return priceB - priceA;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    const normalRequests = requests
      .filter((r) => r.priority === 'LOW' || r.priority === 'NORMAL')
      .sort((a, b) => {
        const priceA = a.auctionPrice ? Number(a.auctionPrice) : 0;
        const priceB = b.auctionPrice ? Number(b.auctionPrice) : 0;
        if (priceB !== priceA) return priceB - priceA;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    // --- Phase 4: Assign with least-loaded strategy ---
    // For each request, pick the tool pair with the fewest active requests
    // This ensures even distribution even across multiple job runs

    const assignments: Array<{
      requestId: string;
      idTool: string;
      priority: string;
      auctionPrice: string | null;
    }> = [];

    const assignGroup = (
      reqs: typeof priorityRequests,
      pairs: typeof validPairs
    ) => {
      if (pairs.length === 0 || reqs.length === 0) return;

      for (const req of reqs) {
        const toolService = this.mapServiceTypeToToolService(req.serviceType);
        const matchingPairs = pairs.filter((p) => p.service === toolService);

        if (matchingPairs.length === 0) continue;

        // Pick the pair with the least load
        let bestPair = matchingPairs[0];
        let bestLoad = loadMap.get(bestPair.idToolValue) ?? 0;

        for (let i = 1; i < matchingPairs.length; i++) {
          const load = loadMap.get(matchingPairs[i].idToolValue) ?? 0;
          if (load < bestLoad) {
            bestLoad = load;
            bestPair = matchingPairs[i];
          }
        }

        // Increment load counter for the selected pair
        loadMap.set(bestPair.idToolValue, bestLoad + 1);

        assignments.push({
          requestId: req.id,
          idTool: bestPair.idToolValue,
          priority: req.priority,
          auctionPrice: req.auctionPrice ? req.auctionPrice.toString() : null,
        });
      }
    };

    // Process priority requests first with priority tool pairs
    assignGroup(priorityRequests, priorityPairs);
    // Process normal requests with normal tool pairs
    assignGroup(normalRequests, normalPairs);

    // --- Phase 5: Batch update with optimistic lock ---
    const { assigned, assignedDetails } = await this.applyAssignments(assignments);

    if (assigned > 0) {
      this.fastify.log.info(
        { assigned, total: unassignedRequests.length, pairs: validPairs.length },
        `Auto-assigned idTool to ${assigned} requests`
      );
    }

    // ==================== RE_RUNNING TOOLS â†’ RE_RUN REQUESTS ====================
    // Separate block: find RE_RUNNING tool pairs and assign to RE_RUN requests

    const reRunResult = await this.autoAssignReRunTools();

    return {
      assigned: assigned + reRunResult.assigned,
      skipped: (unassignedRequests.length - assigned) + reRunResult.skipped,
      details: [
        ...assignedDetails,
        ...reRunResult.details,
      ],
    };
  }

  /**
   * Auto-assign RE_RUNNING tool pairs to RE_RUN requests
   * Same logic as autoAssignTools() but for supplement requests
   */
  private async autoAssignReRunTools(): Promise<{
    assigned: number;
    skipped: number;
    details: Array<{
      requestId: string;
      idTool: string;
      priority: string;
      auctionPrice: string | null;
    }>;
  }> {
    // Phase 1: Find RE_RUNNING tool pairs
    const validPairs = await this.buildValidToolPairs('RE_RUNNING');

    if (validPairs.length === 0) {
      return { assigned: 0, skipped: 0, details: [] };
    }

    // Phase 2: Count existing load from RE_RUN/RE_RUNNING requests
    const loadMap = await this.buildLoadMapForPairs(validPairs, [
      RequestStatus.RE_RUN,
      RequestStatus.RE_RUNNING,
    ]);

    // Find unassigned RE_RUN requests
    const unassignedRequests = await this.prisma.serviceRequest.findMany({
      where: {
        idTool: null,
        status: RequestStatus.RE_RUN,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    if (unassignedRequests.length === 0) {
      return { assigned: 0, skipped: 0, details: [] };
    }

    // Phase 3: Assign with least-loaded strategy
    const assignments: AssignmentDetail[] = [];

    type RequestWithPriority = (typeof unassignedRequests)[0] & { priority: string };
    const requests = unassignedRequests as RequestWithPriority[];

    for (const req of requests) {
      const toolService = this.mapServiceTypeToToolService(req.serviceType);
      const matchingPairs = validPairs.filter((p) => p.service === toolService);

      if (matchingPairs.length === 0) continue;

      let bestPair = matchingPairs[0];
      let bestLoad = loadMap.get(bestPair.idToolValue) ?? 0;

      for (let i = 1; i < matchingPairs.length; i++) {
        const load = loadMap.get(matchingPairs[i].idToolValue) ?? 0;
        if (load < bestLoad) {
          bestLoad = load;
          bestPair = matchingPairs[i];
        }
      }

      loadMap.set(bestPair.idToolValue, bestLoad + 1);

      assignments.push({
        requestId: req.id,
        idTool: bestPair.idToolValue,
        priority: req.priority,
        auctionPrice: req.auctionPrice ? req.auctionPrice.toString() : null,
      });
    }

    // Phase 4: Batch update
    const { assigned, assignedDetails } = await this.applyAssignments(assignments);

    if (assigned > 0) {
      this.fastify.log.info(
        { assigned, total: unassignedRequests.length, pairs: validPairs.length },
        `Auto-assigned RE_RUNNING idTool to ${assigned} RE_RUN requests`
      );
    }

    return {
      assigned,
      skipped: unassignedRequests.length - assigned,
      details: assignedDetails,
    };
  }
}
