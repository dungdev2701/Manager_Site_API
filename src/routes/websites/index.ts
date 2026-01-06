import { FastifyPluginAsync } from 'fastify';
import { WebsiteController } from '../../controllers/website.controller';
import { PerformanceController } from '../../controllers/performance.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';
import {
  canViewWebsites,
  canCreateWebsites,
  canUpdateWebsites,
  canDeleteWebsites,
} from '../../middlewares/role.middleware';

const websiteRoutes: FastifyPluginAsync = async (
  fastify,
  opts
): Promise<void> => {
  // Statistics - ALL can view
  fastify.get(
    '/statistics',
    { preHandler: [authMiddleware, canViewWebsites] },
    WebsiteController.statistics
  );

  // Get all website IDs (for Select All) - ALL can view
  fastify.get(
    '/all-ids',
    { preHandler: [authMiddleware, canViewWebsites] },
    WebsiteController.getAllIds
  );

  // Get websites by IDs (for Export) - ALL can view
  fastify.post(
    '/by-ids',
    { preHandler: [authMiddleware, canViewWebsites] },
    WebsiteController.getByIds
  );

  // Create single website - ADMIN, MANAGER only
  fastify.post(
    '/create',
    { preHandler: [authMiddleware, canCreateWebsites] },
    WebsiteController.create
  );

  // Create bulk websites - ADMIN, MANAGER only
  fastify.post(
    '/create-bulk',
    { preHandler: [authMiddleware, canCreateWebsites] },
    WebsiteController.createBulk
  );

  // Create bulk websites with metrics (from Excel) - ADMIN, MANAGER only
  fastify.post(
    '/create-bulk-with-metrics',
    { preHandler: [authMiddleware, canCreateWebsites] },
    WebsiteController.createBulkWithMetrics
  );

  // List websites - ALL can view
  fastify.get(
    '/list',
    { preHandler: [authMiddleware, canViewWebsites] },
    WebsiteController.findAll
  );

  // Get website detail - ALL can view
  fastify.get(
    '/detail/:id',
    { preHandler: [authMiddleware, canViewWebsites] },
    WebsiteController.findOne
  );

  // Update website - ADMIN, MANAGER, CHECKER
  fastify.put(
    '/update/:id',
    { preHandler: [authMiddleware, canUpdateWebsites] },
    WebsiteController.update
  );

  // Delete website (soft delete) - ADMIN only
  fastify.delete(
    '/delete/:id',
    { preHandler: [authMiddleware, canDeleteWebsites] },
    WebsiteController.delete
  );

  // Get trash (deleted websites) - ADMIN only
  fastify.get(
    '/trash',
    { preHandler: [authMiddleware, canDeleteWebsites] },
    WebsiteController.findDeleted
  );

  // Restore website from trash - ADMIN only
  fastify.post(
    '/restore/:id',
    { preHandler: [authMiddleware, canDeleteWebsites] },
    WebsiteController.restore
  );

  // Permanently delete website - ADMIN only
  fastify.delete(
    '/permanent/:id',
    { preHandler: [authMiddleware, canDeleteWebsites] },
    WebsiteController.permanentDelete
  );

  // ==================== PERFORMANCE ====================
  // Get website performance data - ALL can view
  fastify.get(
    '/performance/:id',
    { preHandler: [authMiddleware, canViewWebsites] },
    PerformanceController.getPerformance
  );

  // Compare performance between two periods - ALL can view
  fastify.get(
    '/performance/:id/compare',
    { preHandler: [authMiddleware, canViewWebsites] },
    PerformanceController.comparePerformance
  );
};

export default websiteRoutes;
