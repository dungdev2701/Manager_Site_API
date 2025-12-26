import { FastifyPluginAsync } from 'fastify';
import { AllocationController } from '../../controllers/allocation.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { canViewWebsites, canUpdateWebsites } from '../../middlewares/role.middleware';

const allocationRoutes: FastifyPluginAsync = async (
  fastify,
  opts
): Promise<void> => {
  // Create controller instance
  const controller = new AllocationController(fastify);

  // Health check - no auth required
  fastify.get('/health', controller.healthCheck.bind(controller));

  // Statistics - ADMIN, MANAGER can view
  fastify.get(
    '/statistics',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getStatistics.bind(controller)
  );

  // Process pending requests - ADMIN, MANAGER only
  fastify.post(
    '/process',
    { preHandler: [authMiddleware, canUpdateWebsites] },
    controller.processPendingRequests.bind(controller)
  );

  // Sync completed requests - ADMIN, MANAGER only
  fastify.post(
    '/sync',
    { preHandler: [authMiddleware, canUpdateWebsites] },
    controller.syncCompletedRequests.bind(controller)
  );

  // Get request allocation results
  fastify.get(
    '/request/:requestId',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getRequestResults.bind(controller)
  );

  // Get website success rate stats
  fastify.get(
    '/website/:websiteId/stats',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getWebsiteStats.bind(controller)
  );
};

export default allocationRoutes;
