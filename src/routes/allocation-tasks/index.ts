import { FastifyPluginAsync } from 'fastify';
import { AllocationTaskController } from '../../controllers/allocation-task.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { canViewWebsites, canUpdateWebsites } from '../../middlewares/role.middleware';
import { monitorApiKeyMiddleware } from '../../middlewares/monitor.middleware';

// Rate limit configs
const RATE_LIMITS = {
  // Heavy operations: 10 requests / 1 minute
  heavy: { max: 10, timeWindow: '1 minute' },
  // Normal operations: 60 requests / 1 minute
  normal: { max: 60, timeWindow: '1 minute' },
  // Read operations: 500 requests / 1 minute
  read: { max: 500, timeWindow: '1 minute' },
  // Tool operations: Higher limit for automation
  tool: { max: 1000, timeWindow: '1 minute' },
};

const allocationTaskRoutes: FastifyPluginAsync = async (
  fastify
): Promise<void> => {
  const controller = new AllocationTaskController(fastify);

  // ==================== MONITOR SERVICE APIs ====================
  // These require Monitor API Key authentication

  /**
   * POST /allocation-tasks/process
   * Monitor Service triggers allocation for NEW requests
   */
  fastify.post(
    '/process',
    {
      preHandler: monitorApiKeyMiddleware,
      config: { rateLimit: RATE_LIMITS.normal },
    },
    controller.processNewRequests.bind(controller)
  );

  /**
   * POST /allocation-tasks/release-expired
   * Monitor Service releases expired claims
   */
  fastify.post(
    '/release-expired',
    {
      preHandler: monitorApiKeyMiddleware,
      config: { rateLimit: RATE_LIMITS.normal },
    },
    controller.releaseExpiredClaims.bind(controller)
  );

  // ==================== TOOL APIs ====================
  // No authentication required - tools use their own identification

  /**
   * POST /allocation-tasks/claim
   * Tools claim pending tasks
   */
  fastify.post(
    '/claim',
    { config: { rateLimit: RATE_LIMITS.tool } },
    controller.claimTasks.bind(controller)
  );

  /**
   * POST /allocation-tasks/:itemId/complete
   * Tools complete a claimed task
   */
  fastify.post(
    '/:itemId/complete',
    { config: { rateLimit: RATE_LIMITS.tool } },
    controller.completeTask.bind(controller)
  );

  /**
   * GET /allocation-tasks/pending
   * Tools view pending tasks (without claiming)
   */
  fastify.get(
    '/pending',
    { config: { rateLimit: RATE_LIMITS.tool } },
    controller.getPendingTasks.bind(controller)
  );

  // ==================== ADMIN APIs ====================
  // These require JWT authentication + role permissions

  /**
   * GET /allocation-tasks/statistics
   * Get allocation statistics (admin only)
   */
  fastify.get(
    '/statistics',
    {
      preHandler: [authMiddleware, canViewWebsites],
      config: { rateLimit: RATE_LIMITS.read },
    },
    controller.getStatistics.bind(controller)
  );

  /**
   * GET /allocation-tasks/config
   * Get all configs (admin only)
   */
  fastify.get(
    '/config',
    {
      preHandler: [authMiddleware, canViewWebsites],
      config: { rateLimit: RATE_LIMITS.read },
    },
    controller.getConfigs.bind(controller)
  );

  /**
   * PUT /allocation-tasks/config/:key
   * Update a config value (admin only)
   */
  fastify.put(
    '/config/:key',
    {
      preHandler: [authMiddleware, canUpdateWebsites],
      config: { rateLimit: RATE_LIMITS.normal },
    },
    controller.updateConfig.bind(controller)
  );

  /**
   * POST /allocation-tasks/config/reset-defaults
   * Reset all configs to defaults (admin only)
   */
  fastify.post(
    '/config/reset-defaults',
    {
      preHandler: [authMiddleware, canUpdateWebsites],
      config: { rateLimit: RATE_LIMITS.heavy },
    },
    controller.resetConfigDefaults.bind(controller)
  );

  /**
   * POST /allocation-tasks/config/initialize
   * Initialize default configs (admin only, safe operation)
   */
  fastify.post(
    '/config/initialize',
    {
      preHandler: [authMiddleware, canUpdateWebsites],
      config: { rateLimit: RATE_LIMITS.normal },
    },
    controller.initializeConfigs.bind(controller)
  );
};

export default allocationTaskRoutes;
