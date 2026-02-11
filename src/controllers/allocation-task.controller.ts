import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { ServiceType, AllocationItemStatus } from '@prisma/client';
import { ServiceRequestAllocationService } from '../services/service-request-allocation.service';
import { SystemConfigService } from '../services/system-config.service';

// ==================== TYPES ====================

interface ClaimTasksBody {
  toolId: string;
  serviceType?: ServiceType;
  limit?: number;
  supportedDomains?: string[] | string; // Filter tasks by domains - array or comma-separated string
  includeConnecting?: boolean; // If true, also claim CONNECTING tasks for stacking phase
}

interface CompleteTaskBody {
  success: boolean;
  linkProfile?: string;
  linkPost?: string;
  errorCode?: string;
  errorMessage?: string;
}

interface UpdateStatusBody {
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

interface ProcessRequestsQuery {
  serviceType?: ServiceType;
}

// ==================== CONTROLLER ====================

/**
 * Controller xử lý các API cho allocation tasks
 *
 * Endpoints dành cho:
 * 1. Monitor Service: trigger allocation
 * 2. Tools: claim và complete tasks
 * 3. Admin: view statistics và config
 */
export class AllocationTaskController {
  private allocationService: ServiceRequestAllocationService;
  private configService: SystemConfigService;

  constructor(fastify: FastifyInstance) {
    this.allocationService = new ServiceRequestAllocationService(fastify);
    this.configService = new SystemConfigService(fastify);
  }

  // ==================== MONITOR SERVICE APIs ====================

  /**
   * POST /allocation-tasks/process
   *
   * Monitor Service gọi để trigger allocation cho NEW requests
   */
  async processNewRequests(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const query = request.query as ProcessRequestsQuery;
    const serviceType = query.serviceType;
    const result = await this.allocationService.processNewRequests(serviceType);
    reply.send({
      success: true,
      message: 'Processed new requests',
      data: result,
    });
  }

  /**
   * POST /allocation-tasks/release-expired
   *
   * Monitor Service gọi để release expired claims
   */
  async releaseExpiredClaims(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const count = await this.allocationService.releaseExpiredClaims();
    reply.send({
      success: true,
      message: `Released ${count} expired claims`,
      data: { releasedCount: count },
    });
  }

  /**
   * POST /allocation-tasks/timeout-requests
   *
   * Monitor Service gọi để timeout các requests đã hết thời gian
   * - entityLimit >= 100: timeout = (entityLimit / 100) * REQUEST_COMPLETION_TIME_PER_100
   * - entityLimit < 100: timeout = 30 phút (cố định)
   */
  async timeoutExpiredRequests(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const result = await this.allocationService.timeoutExpiredRequests();
    reply.send({
      success: true,
      message: result.timedOut > 0
        ? `Timed out ${result.timedOut} requests, cancelled ${result.cancelledItems} items`
        : 'No requests to timeout',
      data: result,
    });
  }

  /**
   * POST /allocation-tasks/trigger-stacking
   *
   * Monitor Service gọi để trigger stacking cho requests đã đạt threshold
   *
   * Logic:
   * - entityConnect = 'all': Check if linkProfile count >= entityLimit
   * - entityConnect = 'limit': Check if linkProfile count >= limit value
   *
   * Khi đạt threshold, set stackingReady=true cho các CONNECTING tasks
   * để tools có thể claim và thực hiện stacking
   */
  async triggerStackingForReadyRequests(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const result = await this.allocationService.triggerStackingForReadyRequests();
    reply.send({
      success: true,
      message: result.triggered > 0
        ? `Triggered stacking for ${result.triggered} requests, updated ${result.updatedItems} items`
        : 'No requests ready for stacking',
      data: result,
    });
  }

  // ==================== TOOL APIs ====================

  /**
   * POST /allocation-tasks/claim
   *
   * Tool gọi để claim pending tasks
   *
   * Body:
   * {
   *   "toolId": "Normal 1;Captcha 1",  // Required
   *   "serviceType": "ENTITY",          // Optional filter
   *   "limit": 10,                      // Optional, default 10
   *   "supportedDomains": ["site1.com", "site2.com"],  // Optional: only get tasks for these domains
   *   "includeConnecting": true         // Optional: also claim CONNECTING tasks for stacking
   * }
   *
   * Tool type logic (from tools table):
   * - GLOBAL: Claim all available tasks (idTool is NULL or matches toolId)
   * - INDIVIDUAL: Only claim tasks where request.idTool matches this toolId exactly
   *
   * Status flow:
   * - NEW tasks → REGISTERING (tool does registration/profiling)
   * - CONNECTING tasks → remains CONNECTING (tool does stacking)
   */
  async claimTasks(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const body = request.body as ClaimTasksBody;
    const { toolId, serviceType, limit, supportedDomains, includeConnecting } = body;

    if (!toolId) {
      reply.status(400).send({
        success: false,
        message: 'toolId is required',
      });
      return;
    }

    // Parse supportedDomains: accept array or comma-separated string
    let domainsArray: string[] | undefined;
    if (supportedDomains) {
      if (Array.isArray(supportedDomains)) {
        domainsArray = supportedDomains;
      } else if (typeof supportedDomains === 'string') {
        domainsArray = supportedDomains.split(',').map((d) => d.trim()).filter((d) => d.length > 0);
      }
    }

    const result = await this.allocationService.claimTasks(
      toolId,
      serviceType,
      limit || 10,
      domainsArray,
      includeConnecting || false
    );

    reply.send({
      success: result.success,
      message: result.message || `Claimed ${result.items.length} tasks`,
      data: {
        count: result.items.length,
        items: result.items,
      },
    });
  }

  /**
   * POST /allocation-tasks/:itemId/complete
   *
   * Tool gọi khi hoàn thành một task
   *
   * Body:
   * {
   *   "success": true,
   *   "linkProfile": "https://example.com/profile/123",
   *   "linkPost": "https://example.com/post/456",
   *   "errorCode": "CAPTCHA_FAILED",      // If success=false
   *   "errorMessage": "Failed to solve"   // If success=false
   * }
   */
  async completeTask(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const params = request.params as { itemId: string };
    const { itemId } = params;
    const body = request.body as CompleteTaskBody;

    if (typeof body.success !== 'boolean') {
      reply.status(400).send({
        success: false,
        message: 'success field is required and must be boolean',
      });
      return;
    }

    const result = await this.allocationService.completeTask(itemId, {
      success: body.success,
      linkProfile: body.linkProfile,
      linkPost: body.linkPost,
      errorCode: body.errorCode,
      errorMessage: body.errorMessage,
    });

    if (!result.success) {
      reply.status(400).send({
        success: false,
        message: result.message,
      });
      return;
    }

    reply.send({
      success: true,
      message: 'Task completed',
    });
  }

  /**
   * PUT /allocation-tasks/:itemId/status
   *
   * Cập nhật status của allocation item
   * Cho phép cập nhật status tùy ý (không chỉ complete)
   */
  async updateTaskStatus(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const params = request.params as { itemId: string };
    const { itemId } = params;
    const body = request.body as UpdateStatusBody;

    if (!body.status) {
      reply.status(400).send({
        success: false,
        message: 'status field is required',
      });
      return;
    }

    // Validate status is a valid AllocationItemStatus
    const validStatuses = Object.values(AllocationItemStatus);
    if (!validStatuses.includes(body.status)) {
      reply.status(400).send({
        success: false,
        message: `Invalid status. Valid values: ${validStatuses.join(', ')}`,
      });
      return;
    }

    const result = await this.allocationService.updateTaskStatus(itemId, {
      status: body.status,
      linkProfile: body.linkProfile,
      linkPost: body.linkPost,
      note: body.note,
      errorCode: body.errorCode,
      errorMessage: body.errorMessage,
      // Extended fields
      linkData: body.linkData,
      claimedBy: body.claimedBy,
      claimedAt: body.claimedAt,
      claimTimeout: body.claimTimeout,
      retryIndex: body.retryIndex,
      linkStatus: body.linkStatus,
      externalLinkId: body.externalLinkId,
    });

    if (!result.success) {
      reply.status(400).send({
        success: false,
        message: result.message,
      });
      return;
    }

    reply.send({
      success: true,
      message: `Task status updated to ${body.status}`,
      data: result.item,
    });
  }

  /**
   * GET /allocation-tasks/pending
   *
   * Tool gọi để xem pending tasks (không claim)
   */
  async getPendingTasks(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const query = request.query as { toolId: string; serviceType?: ServiceType };
    const { toolId, serviceType } = query;

    if (!toolId) {
      reply.status(400).send({
        success: false,
        message: 'toolId is required',
      });
      return;
    }

    const result = await this.allocationService.getPendingTasksForTool(toolId, serviceType);

    reply.send({
      success: true,
      data: result,
    });
  }

  // ==================== STATISTICS APIs ====================

  /**
   * GET /allocation-tasks/statistics
   *
   * Get overall allocation statistics
   */
  async getStatistics(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const stats = await this.allocationService.getStatistics();
    reply.send({
      success: true,
      data: stats,
    });
  }

  // ==================== CONFIG APIs ====================

  /**
   * GET /allocation-tasks/config
   *
   * Get all allocation-related configs
   */
  async getConfigs(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const configs = await this.configService.getAll();
    reply.send({
      success: true,
      data: configs,
    });
  }

  /**
   * PUT /allocation-tasks/config/:key
   *
   * Update a config value
   */
  async updateConfig(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const params = request.params as { key: string };
    const body = request.body as { value: string; description?: string };
    const { key } = params;
    const { value, description } = body;

    if (!value) {
      reply.status(400).send({
        success: false,
        message: 'value is required',
      });
      return;
    }

    // Get user ID from auth if available
    const userId = (request as any).user?.id;

    const config = await this.configService.set(key, {
      value,
      description,
      updatedBy: userId,
    });

    reply.send({
      success: true,
      message: `Config '${key}' updated`,
      data: config,
    });
  }

  /**
   * POST /allocation-tasks/config/reset-defaults
   *
   * Reset all configs to default values
   */
  async resetConfigDefaults(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const count = await this.configService.resetAllToDefaults();
    reply.send({
      success: true,
      message: `Reset ${count} configs to defaults`,
    });
  }

  /**
   * POST /allocation-tasks/config/initialize
   *
   * Initialize default configs (safe - only creates missing)
   */
  async initializeConfigs(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const count = await this.configService.initializeDefaults();
    reply.send({
      success: true,
      message: count > 0 ? `Initialized ${count} default configs` : 'All configs already exist',
    });
  }
}
