import { FastifyPluginAsync } from 'fastify';
import { StatisticsController } from '../../controllers/statistics.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { canViewWebsites } from '../../middlewares/role.middleware';

const statisticsRoutes: FastifyPluginAsync = async (fastify) => {
  const controller = new StatisticsController(fastify);

  // Get overall statistics
  fastify.get(
    '/overview',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getOverview.bind(controller)
  );

  // Get website statistics by status
  fastify.get(
    '/by-status',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getByStatus.bind(controller)
  );

  // Get website statistics by type
  fastify.get(
    '/by-type',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getByType.bind(controller)
  );

  // Get allocation statistics over time
  fastify.get(
    '/allocations',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getAllocationStats.bind(controller)
  );

  // Get top performing websites
  fastify.get(
    '/top-websites',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getTopWebsites.bind(controller)
  );

  // Get editor performance statistics
  fastify.get(
    '/editors',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getEditorStats.bind(controller)
  );

  // Get daily trends
  fastify.get(
    '/trends',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getDailyTrends.bind(controller)
  );

  // Get status changes over time
  fastify.get(
    '/status-changes',
    { preHandler: [authMiddleware, canViewWebsites] },
    controller.getStatusChanges.bind(controller)
  );

  // ============ CTV Statistics Routes ============
  // These endpoints return data only for the current user's websites

  // Get CTV overview statistics
  fastify.get(
    '/my/overview',
    { preHandler: [authMiddleware] },
    controller.getCTVOverview.bind(controller)
  );

  // Get CTV website statistics by status
  fastify.get(
    '/my/by-status',
    { preHandler: [authMiddleware] },
    controller.getCTVByStatus.bind(controller)
  );

  // Get CTV website statistics by type
  fastify.get(
    '/my/by-type',
    { preHandler: [authMiddleware] },
    controller.getCTVByType.bind(controller)
  );

  // Get CTV daily trends
  fastify.get(
    '/my/trends',
    { preHandler: [authMiddleware] },
    controller.getCTVDailyTrends.bind(controller)
  );

  // Get CTV status changes over time
  fastify.get(
    '/my/status-changes',
    { preHandler: [authMiddleware] },
    controller.getCTVStatusChanges.bind(controller)
  );

  // Get CTV income statistics
  fastify.get(
    '/my/income',
    { preHandler: [authMiddleware] },
    controller.getCTVIncomeStats.bind(controller)
  );

  // ============ DEV Statistics Routes ============
  // These endpoints return data for websites edited by the DEV

  // Get DEV overview statistics
  fastify.get(
    '/dev/overview',
    { preHandler: [authMiddleware] },
    controller.getDEVOverview.bind(controller)
  );

  // Get DEV website statistics by status
  fastify.get(
    '/dev/by-status',
    { preHandler: [authMiddleware] },
    controller.getDEVByStatus.bind(controller)
  );

  // Get DEV daily trends
  fastify.get(
    '/dev/trends',
    { preHandler: [authMiddleware] },
    controller.getDEVDailyTrends.bind(controller)
  );

  // Get DEV status changes over time
  fastify.get(
    '/dev/status-changes',
    { preHandler: [authMiddleware] },
    controller.getDEVStatusChanges.bind(controller)
  );

  // Get DEV top performing websites
  fastify.get(
    '/dev/top-websites',
    { preHandler: [authMiddleware] },
    controller.getDEVTopWebsites.bind(controller)
  );

  // Get DEV error websites
  fastify.get(
    '/dev/error-websites',
    { preHandler: [authMiddleware] },
    controller.getDEVErrorWebsites.bind(controller)
  );
};

export default statisticsRoutes;
