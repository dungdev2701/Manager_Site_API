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
  Prisma,
  ServiceRequest,
} from '@prisma/client';
import { MySQLExternalRepositories } from '../repositories/mysql-external';

// ==================== TYPES ====================

interface WebsiteForAllocation {
  id: string;
  domain: string;
  traffic: number;
  successRate: number;
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
} as const;

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
   * Calculate timeout for a request based on entityLimit
   * - entityLimit >= 100: timeout = (entityLimit / 100) * completionTimePer100
   * - entityLimit < 100: timeout = 30 minutes (fixed, priority completion)
   */
  calculateRequestTimeout(entityLimit: number, completionTimePer100: number): number {
    if (entityLimit < 100) {
      return SMALL_REQUEST_TIMEOUT_MINUTES;
    }
    return Math.ceil((entityLimit / 100) * completionTimePer100);
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
        await this.allocateForRequestOptimized(request, multiplier, claimTimeout);

        // Update status to PENDING
        await this.prisma.serviceRequest.update({
          where: { id: request.id },
          data: { status: RequestStatus.PENDING },
        });

        processed++;
      } catch (error) {
        this.fastify.log.error({ err: error, requestId: request.id }, 'Failed to process request');
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
   * Allocate websites for a specific request (OPTIMIZED version)
   * Uses pre-fetched configs and batched operations
   */
  private async allocateForRequestOptimized(
    request: ServiceRequest,
    multiplier: number,
    claimTimeout: number
  ): Promise<AllocationResult> {
    // Get entityLimit from config
    const config = request.config as Record<string, unknown> | null;
    const entityLimit = (config?.entityLimit as number) || 100;

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
   */
  private async allocateWebsitesOptimized(
    tx: Prisma.TransactionClient,
    batchId: string,
    requestId: string,
    serviceType: ServiceType,
    highTrafficTarget: number,
    lowTrafficTarget: number,
    linkData: Record<string, unknown>,
    claimTimeout: number
  ): Promise<{
    websites: Array<{ websiteId: string; domain: string; trafficType: TrafficType }>;
    highTrafficCount: number;
    lowTrafficCount: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get available websites (uses caching)
    const availableWebsites = await this.getAvailableWebsitesOptimized(today, serviceType);

    // Separate by traffic
    const highTrafficWebsites = availableWebsites.filter((w) => w.traffic >= TRAFFIC_THRESHOLD);
    const lowTrafficWebsites = availableWebsites.filter((w) => w.traffic < TRAFFIC_THRESHOLD);

    // Sort by success rate (higher first)
    highTrafficWebsites.sort((a, b) => b.successRate - a.successRate);
    lowTrafficWebsites.sort((a, b) => b.successRate - a.successRate);

    // Select websites
    const selectedHigh = highTrafficWebsites.slice(0, highTrafficTarget);
    const selectedLow = lowTrafficWebsites.slice(0, lowTrafficTarget);

    // Combine
    const allSelected = [
      ...selectedHigh.map((w) => ({ ...w, trafficType: TrafficType.HIGH })),
      ...selectedLow.map((w) => ({ ...w, trafficType: TrafficType.LOW })),
    ];

    if (allSelected.length > 0) {
      // OPTIMIZATION: Use createMany for bulk insert
      await tx.allocationItem.createMany({
        data: allSelected.map((w) => ({
          batchId,
          requestId, // Direct reference to ServiceRequest for fast lookups
          websiteId: w.id,
          domain: w.domain,
          serviceType,
          trafficType: w.trafficType,
          priorityScore: w.successRate,
          status: AllocationItemStatus.NEW,
          claimTimeout,
          linkData: linkData as Prisma.InputJsonValue,
        })),
      });

      // OPTIMIZATION: Batch upsert daily allocations using raw SQL
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

    // OPTIMIZATION: Run queries in parallel
    const [websites, dailyAllocations, statsRecords] = await Promise.all([
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
      // Query 3: Get success rates (will filter by websiteIds after)
      this.prisma.websiteStats.findMany({
        where: { periodType: 'MONTHLY' },
        orderBy: { periodStart: 'desc' },
        distinct: ['websiteId'],
        select: { websiteId: true, successRate: true },
      }),
    ]);

    // Build lookup maps
    const allocationMap = new Map(dailyAllocations.map((d) => [d.websiteId, d.allocationCount]));
    const statsMap = new Map(statsRecords.map((s) => [s.websiteId, s.successRate]));

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
   */
  private async batchUpsertDailyAllocations(
    tx: Prisma.TransactionClient,
    websiteIds: string[],
    date: Date
  ): Promise<void> {
    if (websiteIds.length === 0) return;

    // Use raw SQL for efficient batch upsert
    // PostgreSQL ON CONFLICT syntax
    const dateStr = date.toISOString().split('T')[0];
    const values = websiteIds
      .map((id) => `('${crypto.randomUUID()}', '${id}', '${dateStr}'::date, 1, NOW())`)
      .join(',');

    await tx.$executeRawUnsafe(`
      INSERT INTO daily_allocations (id, "websiteId", date, "allocationCount", "updatedAt")
      VALUES ${values}
      ON CONFLICT ("websiteId", date)
      DO UPDATE SET
        "allocationCount" = daily_allocations."allocationCount" + 1,
        "updatedAt" = NOW()
    `);
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
   * - NEW tasks → REGISTERING (tool will do registration/profiling)
   * - CONNECTING tasks → CONNECTING (tool will do stacking, status remains CONNECTING)
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
    // Cast status values to AllocationItemStatus enum for PostgreSQL
    const statusCondition = includeConnecting
      ? `ai.status IN ('NEW'::"AllocationItemStatus", 'CONNECTING'::"AllocationItemStatus")`
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

    // Debug log
    this.fastify.log.info({
      toolId,
      toolType,
      serviceType,
      supportedDomainsCount: supportedDomains?.length,
      includeConnecting,
      paramIndex,
      limitParamIndex,
      toolIdUpdateIndex,
      timeoutParamIndex,
      paramsCount: params.length,
      whereClause,
      params: params.map((p, i) => `$${i + 1}=${typeof p === 'string' && p.length > 50 ? p.substring(0, 50) + '...' : p}`),
    }, 'claimTasks query debug');

    try {
      // DEBUG: Count items matching each condition to identify which filter fails
      if (process.env.NODE_ENV !== 'production') {
        const debugCounts = await this.prisma.$queryRaw<Array<{
          total_items: bigint;
          items_with_new_status: bigint;
          items_joinable_to_requests: bigint;
          items_with_null_idtool: bigint;
        }>>`
          SELECT
            (SELECT COUNT(*) FROM allocation_items) as total_items,
            (SELECT COUNT(*) FROM allocation_items WHERE status = 'NEW'::"AllocationItemStatus") as items_with_new_status,
            (SELECT COUNT(*) FROM allocation_items ai
              INNER JOIN allocation_batches ab ON ab.id = ai."batchId"
              INNER JOIN service_requests sr ON sr.id = ab."requestId"
            ) as items_joinable_to_requests,
            (SELECT COUNT(*) FROM allocation_items ai
              INNER JOIN allocation_batches ab ON ab.id = ai."batchId"
              INNER JOIN service_requests sr ON sr.id = ab."requestId"
              WHERE sr."idTool" IS NULL
            ) as items_with_null_idtool
        `;
        this.fastify.log.info({ debugCounts: debugCounts[0] }, 'claimTasks debug counts');
      }

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
            -- NEW tasks → REGISTERING, CONNECTING tasks stay CONNECTING (for stacking)
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
      const errorDetails = {
        toolId,
        toolType,
        serviceType,
        limit,
        includeConnecting,
        supportedDomainsCount: supportedDomains?.length,
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack?.split('\n').slice(0, 3).join('\n') : undefined,
      };
      this.fastify.log.error(errorDetails, 'Failed to claim tasks');

      // Return more specific error message for debugging
      const debugMessage = process.env.NODE_ENV !== 'production'
        ? `Failed to claim tasks: ${error instanceof Error ? error.message : String(error)}`
        : 'Failed to claim tasks';
      return { success: false, items: [], message: debugMessage };
    }
  }

  /**
   * Release expired claims - OPTIMIZED with raw SQL
   * - Items with retryIndex < 3: Reset to NEW, increment retryIndex
   * - Items with retryIndex >= 3: Mark as FAILED (max retries exceeded)
   */
  async releaseExpiredClaims(): Promise<number> {
    const MAX_RETRIES = 3;

    // Query 1: Reset items that haven't exceeded max retries back to NEW
    const releasedToNew = await this.prisma.$executeRaw`
      UPDATE allocation_items
      SET
        status = 'NEW',
        "claimedBy" = NULL,
        "claimedAt" = NULL,
        "retryIndex" = "retryIndex" + 1
      WHERE
        status IN ('REGISTERING', 'PROFILING', 'CONNECTING')
        AND "claimedAt" IS NOT NULL
        AND "claimedAt" + ("claimTimeout" * interval '1 minute') < NOW()
        AND "retryIndex" < ${MAX_RETRIES}
    `;

    // Query 2: Mark items that exceeded max retries as FAILED
    const markedFailed = await this.prisma.$executeRaw`
      UPDATE allocation_items
      SET
        status = 'FAILED',
        "errorCode" = 'MAX_RETRIES_EXCEEDED',
        "errorMessage" = 'Task failed after ' || ("retryIndex" + 1) || ' retries (timeout)',
        "completedAt" = NOW()
      WHERE
        status IN ('REGISTERING', 'PROFILING', 'CONNECTING')
        AND "claimedAt" IS NOT NULL
        AND "claimedAt" + ("claimTimeout" * interval '1 minute') < NOW()
        AND "retryIndex" >= ${MAX_RETRIES}
    `;

    if (releasedToNew > 0) {
      this.fastify.log.info({ count: releasedToNew }, 'Released expired claims back to NEW (retryIndex incremented)');
    }

    if (markedFailed > 0) {
      this.fastify.log.warn({ count: markedFailed }, 'Marked expired claims as FAILED (max retries exceeded)');

      // Update failedLinks count for affected requests
      await this.updateFailedLinksForExpiredItems(markedFailed);
    }

    return releasedToNew + markedFailed;
  }

  /**
   * Update failedLinks count for requests that have items marked as FAILED due to max retries
   */
  private async updateFailedLinksForExpiredItems(count: number): Promise<void> {
    if (count === 0) return;

    try {
      // Get requestIds of recently failed items and update their failedLinks count
      await this.prisma.$executeRaw`
        UPDATE service_requests sr
        SET "failedLinks" = "failedLinks" + subq.failed_count
        FROM (
          SELECT ab."requestId", COUNT(*) as failed_count
          FROM allocation_items ai
          INNER JOIN allocation_batches ab ON ab.id = ai."batchId"
          WHERE ai.status = 'FAILED'
            AND ai."errorCode" = 'MAX_RETRIES_EXCEEDED'
            AND ai."completedAt" > NOW() - interval '1 minute'
          GROUP BY ab."requestId"
        ) subq
        WHERE sr.id = subq."requestId"
      `;
    } catch (error) {
      this.fastify.log.error({ error }, 'Failed to update failedLinks for expired items');
    }
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
   * Note: Timeout is calculated from the first AllocationBatch's createdAt,
   * which represents when allocation actually started (not request.updatedAt
   * which changes on any field update)
   */
  async timeoutExpiredRequests(): Promise<{ timedOut: number; cancelledItems: number }> {
    const completionTimePer100 = await this.getRequestCompletionTimePer100();
    let timedOut = 0;
    let cancelledItems = 0;

    // Find RUNNING requests with their first batch's createdAt
    const runningRequests = await this.prisma.serviceRequest.findMany({
      where: {
        status: RequestStatus.RUNNING,
        deletedAt: null,
      },
      select: {
        id: true,
        config: true,
        batches: {
          select: {
            createdAt: true,
          },
          orderBy: {
            batchNumber: 'asc',
          },
          take: 1, // Only get the first batch
        },
      },
    });

    if (runningRequests.length === 0) {
      return { timedOut: 0, cancelledItems: 0 };
    }

    const now = new Date();

    for (const request of runningRequests) {
      // Get the first batch's createdAt as the start time
      const firstBatch = request.batches[0];
      if (!firstBatch) {
        // No batch yet, skip this request
        continue;
      }
      const startTime = firstBatch.createdAt;

      // Get entityLimit from config
      const config = request.config as Record<string, unknown> | null;
      const entityLimit = (config?.entityLimit as number) || 100;

      // Calculate timeout
      const timeoutMinutes = this.calculateRequestTimeout(entityLimit, completionTimePer100);
      const timeoutMs = timeoutMinutes * 60 * 1000;

      // Check if request has expired (from first batch creation time)
      const elapsedMs = now.getTime() - startTime.getTime();
      if (elapsedMs < timeoutMs) {
        continue; // Not expired yet
      }

      try {
        // Use transaction to update request and cancel items atomically
        const result = await this.prisma.$transaction(async (tx) => {
          // Cancel all pending/processing items for this request
          const cancelled = await tx.$executeRaw`
            UPDATE allocation_items ai
            SET
              status = 'CANCEL',
              "errorCode" = 'REQUEST_TIMEOUT',
              "errorMessage" = 'Request timed out after ' || ${timeoutMinutes} || ' minutes',
              "completedAt" = NOW()
            FROM allocation_batches ab
            WHERE ai."batchId" = ab.id
              AND ab."requestId" = ${request.id}
              AND ai.status IN ('NEW', 'REGISTERING', 'PROFILING', 'CONNECTING')
          `;

          // Update request status to COMPLETED
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

        this.fastify.log.warn({
          requestId: request.id,
          entityLimit,
          timeoutMinutes,
          startedAt: startTime.toISOString(),
          elapsedMinutes: Math.round(elapsedMs / 60000),
          cancelledItems: result,
        }, 'Request timed out - marked as COMPLETED and cancelled pending items');

      } catch (error) {
        this.fastify.log.error({ error, requestId: request.id }, 'Failed to timeout request');
      }
    }

    if (timedOut > 0) {
      this.fastify.log.info({ timedOut, cancelledItems }, 'Timed out expired requests');
    }

    return { timedOut, cancelledItems };
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
    // Find the item first with batch to get requestId and existing linkData for merge
    const item = await this.prisma.allocationItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        status: true,
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
    const terminalStatuses: AllocationItemStatus[] = [
      AllocationItemStatus.FINISH,
      AllocationItemStatus.FAILED,
      AllocationItemStatus.CANCEL,
      AllocationItemStatus.FAIL_REGISTERING,
      AllocationItemStatus.FAIL_PROFILING,
      AllocationItemStatus.FAIL_CONNECTING,
    ];
    if (terminalStatuses.includes(data.status)) {
      updateData.completedAt = new Date();
    }

    // Update the item
    const updated = await this.prisma.allocationItem.update({
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

    // If status changed to terminal, update request progress
    const requestId = item.batch?.requestId;
    if (terminalStatuses.includes(data.status) && requestId) {
      this.updateRequestProgressOptimized(this.prisma, requestId).catch((err) => {
        this.fastify.log.warn({ err, requestId }, 'Failed to update request progress after status update');
      });
    }

    return { success: true, item: updated };
  }

  /**
   * Complete a claimed task - OPTIMIZED with single transaction
   *
   * Status determination logic when task has linkProfile (profiling step completed):
   * - If request.status is RUNNING or COMPLETED AND entityConnect !== 'disable'
   *   → Set task status to CONNECTING (tool will claim again for stacking)
   * - Otherwise → Set task status to FINISH
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
    return this.prisma.$transaction(async (tx) => {
      // Get item with batch info and request details for entityConnect check
      const item = await tx.allocationItem.findUnique({
        where: { id: itemId },
        select: {
          id: true,
          status: true,
          websiteId: true,
          domain: true,
          serviceType: true,
          externalLinkId: true,
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

      // Check if item is in a processing state (REGISTERING, PROFILING, CONNECTING)
      const isProcessing =
        item.status === AllocationItemStatus.REGISTERING ||
        item.status === AllocationItemStatus.PROFILING ||
        item.status === AllocationItemStatus.CONNECTING;
      if (!isProcessing) {
        return { success: false, message: `Task is not in processing state (current status: ${item.status})` };
      }

      // Determine the new status based on result and entityConnect config
      let newStatus: AllocationItemStatus;

      if (!result.success) {
        // Failed tasks always go to FAILED status
        newStatus = AllocationItemStatus.FAILED;
      } else if (result.linkProfile && item.batch?.request) {
        // Task completed profiling step (has linkProfile)
        // Check if we need stacking (entityConnect logic)
        const request = item.batch.request;
        const config = request.config as Record<string, unknown> | null;
        const entityConnect = (config?.entityConnect as string) || 'disable';

        // entityConnect logic:
        // - 'disable': No stacking needed → FINISH
        // - 'custom': Stack immediately after profiling → CONNECTING (tool can claim)
        // - 'all': Wait until linkProfile count >= entityLimit → CONNECT (waiting for threshold)
        // - 'limit': Wait until linkProfile count >= limit value → CONNECT (waiting for threshold)
        const requestIsActive =
          request.status === RequestStatus.RUNNING || request.status === RequestStatus.COMPLETED;

        if (!requestIsActive || entityConnect === 'disable') {
          // No stacking needed
          newStatus = AllocationItemStatus.FINISH;
        } else if (entityConnect === 'custom') {
          // Can stack immediately after profiling - tool can claim for stacking
          newStatus = AllocationItemStatus.CONNECTING;
          this.fastify.log.debug({
            itemId,
            entityConnect,
          }, 'Task moving to CONNECTING (ready for stacking - custom mode)');
        } else {
          // entityConnect is 'all' or 'limit' - need to wait for threshold
          // Monitor Job will change CONNECT → CONNECTING when threshold is met
          newStatus = 'CONNECT' as AllocationItemStatus;
          this.fastify.log.debug({
            itemId,
            entityConnect,
          }, 'Task moving to CONNECT (waiting for threshold - all/limit mode)');
        }
      } else {
        // Success but no linkProfile (or no request context) → FINISH
        newStatus = AllocationItemStatus.FINISH;
      }

      const now = new Date();
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);

      // Task is considered "completed" when it has linkProfile (profiling done)
      // CONNECTING is just an optional bonus step for stacking - doesn't affect completion counting
      // So we count task as completed when: FINISH, FAILED, or CONNECTING (with linkProfile)
      const isTaskCompleted =
        newStatus === AllocationItemStatus.FINISH ||
        newStatus === AllocationItemStatus.FAILED ||
        (newStatus === AllocationItemStatus.CONNECTING && result.linkProfile);

      // OPTIMIZATION: Update item, request progress, and daily stats in parallel
      const updatePromises: Promise<unknown>[] = [
        // Update allocation item
        tx.allocationItem.update({
          where: { id: itemId },
          data: {
            status: newStatus,
            linkProfile: result.linkProfile,
            linkPost: result.linkPost,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
            // Set completedAt when task is completed (including CONNECTING with linkProfile)
            // CONNECTING is just bonus stacking step, profiling is already done
            ...(isTaskCompleted && { completedAt: now }),
            resultSyncedAt: now,
          },
        }),
      ];

      // Update request progress and daily stats when task is completed
      // CONNECTING with linkProfile counts as completed (profiling done, stacking is just bonus)
      if (item.batch?.requestId && isTaskCompleted) {
        const incrementField = result.success ? 'completedLinks' : 'failedLinks';
        updatePromises.push(
          tx.serviceRequest.update({
            where: { id: item.batch.requestId },
            data: { [incrementField]: { increment: 1 } },
          })
        );

        // Update daily stats
        updatePromises.push(
          tx.dailyAllocation.upsert({
            where: { websiteId_date: { websiteId: item.websiteId, date: today } },
            create: {
              websiteId: item.websiteId,
              date: today,
              successCount: result.success ? 1 : 0,
              failureCount: result.success ? 0 : 1,
            },
            update: result.success
              ? { successCount: { increment: 1 } }
              : { failureCount: { increment: 1 } },
          })
        );
      }

      await Promise.all(updatePromises);

      // Update progress percent and check completion when task is completed
      if (item.batch?.requestId && isTaskCompleted) {
        await this.updateRequestProgressOptimized(tx, item.batch.requestId);
      }

      return { success: true };
    }, {
      timeout: 10000,
    });
  }

  /**
   * Update request progress - OPTIMIZED
   */
  private async updateRequestProgressOptimized(
    tx: Prisma.TransactionClient,
    requestId: string
  ): Promise<void> {
    const request = await tx.serviceRequest.findUnique({
      where: { id: requestId },
      select: { totalLinks: true, completedLinks: true, failedLinks: true },
    });

    if (!request) return;

    const total = request.totalLinks;
    const completed = request.completedLinks + request.failedLinks;
    const progressPercent = total > 0 ? Math.min(100, (completed / total) * 100) : 0;

    const updateData: Prisma.ServiceRequestUpdateInput = { progressPercent };

    // Check if request is complete
    if (completed >= total && progressPercent >= 100) {
      updateData.status = RequestStatus.COMPLETED;
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
   * When threshold is met, change status from CONNECT → CONNECTING
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
        // Change status from CONNECT → CONNECTING for all tasks of this request
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
          }, 'Triggered stacking for request - threshold reached, CONNECT → CONNECTING');
        }
      }
    }

    if (triggered > 0) {
      this.fastify.log.info({ triggered, updatedItems }, 'Triggered stacking for ready requests');
    }

    return { triggered, updatedItems, details };
  }
}
