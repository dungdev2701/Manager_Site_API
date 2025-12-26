import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { WebsiteService } from '../services/website.service';

/**
 * Cleanup Job Plugin
 * Tự động xóa vĩnh viễn các websites đã bị soft delete quá 30 ngày
 * Chạy mỗi ngày lúc 00:00
 */
const cleanupJobPlugin: FastifyPluginAsync = async (fastify) => {
  const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  let cleanupTimer: NodeJS.Timeout | null = null;

  const runCleanup = async () => {
    try {
      const websiteService = new WebsiteService(fastify);
      const result = await websiteService.cleanupExpiredWebsites();

      if (result.deletedCount > 0) {
        fastify.log.info(
          `Cleanup job: Permanently deleted ${result.deletedCount} expired websites`
        );
      }
    } catch (error) {
      fastify.log.error(error, 'Cleanup job failed');
    }
  };

  // Run cleanup on startup (after a short delay to ensure everything is initialized)
  setTimeout(() => {
    runCleanup();
  }, 5000);

  // Schedule periodic cleanup
  cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL);

  // Cleanup on server close
  fastify.addHook('onClose', async () => {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      fastify.log.info('Cleanup job stopped');
    }
  });

  fastify.log.info('Cleanup job plugin registered - runs every 24 hours');
};

export default fp(cleanupJobPlugin, {
  name: 'cleanup-job',
  dependencies: ['prisma'],
});
