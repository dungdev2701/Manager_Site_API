import { FastifyPluginAsync } from 'fastify';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { requireRole } from '../../middlewares/role.middleware';
import { SystemConfigService } from '../../services/system-config.service';
import { ResponseHelper } from '../../utils/response';
import { Role } from '@prisma/client';

const adminOnly = requireRole(Role.ADMIN);

const systemConfigRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  const configService = new SystemConfigService(fastify);

  // Get all configs
  fastify.get(
    '/list',
    { preHandler: [authMiddleware, adminOnly] },
    async (request, reply) => {
      const configs = await configService.getAll();
      return ResponseHelper.success(reply, configs);
    }
  );

  // Update a config value
  fastify.put(
    '/:key',
    { preHandler: [authMiddleware, adminOnly] },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      const { value, description } = request.body as { value: string; description?: string };

      if (value === undefined || value === null) {
        return ResponseHelper.badRequest(reply, 'value is required');
      }

      const config = await configService.set(key, {
        value: String(value),
        description,
        updatedBy: request.user?.id,
      });

      return ResponseHelper.success(reply, config, `Config '${key}' updated`);
    }
  );

  // Reset single config to default
  fastify.post(
    '/:key/reset',
    { preHandler: [authMiddleware, adminOnly] },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      const config = await configService.resetToDefault(key);

      if (!config) {
        return ResponseHelper.badRequest(reply, `No default found for key '${key}'`);
      }

      return ResponseHelper.success(reply, config, `Config '${key}' reset to default`);
    }
  );

  // Reset all configs to defaults
  fastify.post(
    '/reset-all',
    { preHandler: [authMiddleware, adminOnly] },
    async (request, reply) => {
      const count = await configService.resetAllToDefaults();
      return ResponseHelper.success(reply, { reset: count }, `Reset ${count} configs to defaults`);
    }
  );
};

export default systemConfigRoutes;
