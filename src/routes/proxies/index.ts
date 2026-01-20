import { FastifyPluginAsync } from 'fastify';
import { ProxyController } from '../../controllers/proxy.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';

const proxyRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  // All routes require authentication
  const authPreHandler = [authMiddleware];

  // GET /proxies/list - Get all proxies
  fastify.get('/list', { preHandler: authPreHandler }, ProxyController.findAll);

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
};

export default proxyRoutes;
