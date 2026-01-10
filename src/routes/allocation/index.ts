import { FastifyPluginAsync } from 'fastify';
import { AllocationController } from '../../controllers/allocation.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { canViewWebsites, canUpdateWebsites } from '../../middlewares/role.middleware';

// Rate limit configs cho các loại endpoint khác nhau
const RATE_LIMITS = {
  // Heavy operations: 10 requests / 1 phút (tốn nhiều tài nguyên)
  heavy: { max: 10, timeWindow: '1 minute' },
  // Normal operations: 60 requests / 1 phút (~1 req/giây)
  normal: { max: 60, timeWindow: '1 minute' },
  // Read operations: 500 requests / 1 phút (~8 req/giây)
  read: { max: 500, timeWindow: '1 minute' },
};

const allocationRoutes: FastifyPluginAsync = async (
  fastify,
  opts
): Promise<void> => {
  // Create controller instance
  const controller = new AllocationController(fastify);

  // Health check - no auth required, no rate limit
  fastify.get('/health', controller.healthCheck.bind(controller));

  // Statistics - ADMIN, MANAGER can view (read operation)
  fastify.get(
    '/statistics',
    {
      preHandler: [authMiddleware, canViewWebsites],
      config: { rateLimit: RATE_LIMITS.read },
    },
    controller.getStatistics.bind(controller)
  );

  // Process pending requests - ADMIN, MANAGER only (normal operation)
  fastify.post(
    '/process',
    {
      preHandler: [authMiddleware, canUpdateWebsites],
      config: { rateLimit: RATE_LIMITS.normal },
    },
    controller.processPendingRequests.bind(controller)
  );

  // Sync completed requests - ADMIN, MANAGER only (normal operation)
  fastify.post(
    '/sync',
    {
      preHandler: [authMiddleware, canUpdateWebsites],
      config: { rateLimit: RATE_LIMITS.normal },
    },
    controller.syncCompletedRequests.bind(controller)
  );

  // Get request allocation results (read operation)
  fastify.get(
    '/request/:requestId',
    {
      preHandler: [authMiddleware, canViewWebsites],
      config: { rateLimit: RATE_LIMITS.read },
    },
    controller.getRequestResults.bind(controller)
  );

  // Get website success rate stats (read operation)
  fastify.get(
    '/website/:websiteId/stats',
    {
      preHandler: [authMiddleware, canViewWebsites],
      config: { rateLimit: RATE_LIMITS.read },
    },
    controller.getWebsiteStats.bind(controller)
  );

  // Force resync all allocation results from MySQL - ADMIN, MANAGER only (heavy operation)
  fastify.post(
    '/force-resync',
    {
      preHandler: [authMiddleware, canUpdateWebsites],
      config: { rateLimit: RATE_LIMITS.heavy },
    },
    controller.forceResync.bind(controller)
  );

  // Recalculate stats for all websites - ADMIN, MANAGER only (heavy operation)
  fastify.post(
    '/recalculate-stats',
    {
      preHandler: [authMiddleware, canUpdateWebsites],
      config: { rateLimit: RATE_LIMITS.heavy },
    },
    controller.recalculateStats.bind(controller)
  );
};

export default allocationRoutes;
