import { FastifyPluginAsync } from 'fastify';
import { ProxyController } from '../../controllers/proxy.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { authOrApiKeyMiddleware } from '../../middlewares/auth-or-apikey.middleware';

const proxyRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  // All routes require authentication
  const authPreHandler = [authMiddleware];
  // Routes that allow API key authentication
  const authOrApiKeyPreHandler = [authOrApiKeyMiddleware];

  // GET /proxies/list - Get all proxies (supports JWT or API key)
  fastify.get('/list', { preHandler: authOrApiKeyPreHandler }, ProxyController.findAll);

  // GET /proxies/detail/:id - Get proxy by ID
  fastify.get('/detail/:id', { preHandler: authPreHandler }, ProxyController.findOne);

  // POST /proxies/create - Create new proxy
  fastify.post('/create', { preHandler: authPreHandler }, ProxyController.create);

  // POST /proxies/bulk-create - Bulk create proxies
  fastify.post('/bulk-create', { preHandler: authPreHandler }, ProxyController.bulkCreate);

  // PUT /proxies/update/:id - Update proxy
  fastify.put('/update/:id', { preHandler: authPreHandler }, ProxyController.update);

  // DELETE /proxies/delete/:id - Delete proxy
  fastify.delete('/delete/:id', { preHandler: authPreHandler }, ProxyController.delete);

  // POST /proxies/bulk-delete - Bulk delete proxies
  fastify.post('/bulk-delete', { preHandler: authPreHandler }, ProxyController.bulkDelete);

  // POST /proxies/check/:id - Check single proxy
  fastify.post('/check/:id', { preHandler: authPreHandler }, ProxyController.checkProxy);

  // POST /proxies/check-all - Check all proxies
  fastify.post('/check-all', { preHandler: authPreHandler }, ProxyController.checkAllProxies);

  // POST /proxies/check-selected - Check selected proxies
  fastify.post('/check-selected', { preHandler: authPreHandler }, ProxyController.checkSelectedProxies);

  // GET /proxies/check-status - Get check progress
  fastify.get('/check-status', { preHandler: authPreHandler }, ProxyController.getCheckStatus);

  // POST /proxies/check-stop - Stop ongoing check
  fastify.post('/check-stop', { preHandler: authPreHandler }, ProxyController.stopCheck);

  // ==================== TRASH (Soft Delete) ====================
  // GET /proxies/trash - Get deleted proxies
  fastify.get('/trash', { preHandler: authPreHandler }, ProxyController.getTrash);

  // POST /proxies/restore/:id - Restore single deleted proxy
  fastify.post('/restore/:id', { preHandler: authPreHandler }, ProxyController.restore);

  // POST /proxies/bulk-restore - Bulk restore deleted proxies
  fastify.post('/bulk-restore', { preHandler: authPreHandler }, ProxyController.bulkRestore);

  // DELETE /proxies/permanent-delete/:id - Permanently delete proxy
  fastify.delete('/permanent-delete/:id', { preHandler: authPreHandler }, ProxyController.permanentDelete);

  // POST /proxies/bulk-permanent-delete - Bulk permanent delete proxies
  fastify.post('/bulk-permanent-delete', { preHandler: authPreHandler }, ProxyController.bulkPermanentDelete);

  // POST /proxies/empty-trash - Empty trash
  fastify.post('/empty-trash', { preHandler: authPreHandler }, ProxyController.emptyTrash);
};

export default proxyRoutes;
