import { FastifyPluginAsync } from 'fastify';
import { ServiceRequestController } from '../../controllers/service-request.controller';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware';
import { Role } from '@prisma/client';

const serviceRequestRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  // Tất cả routes require authentication
  const authPreHandler = [authMiddleware];
  const adminPreHandler = [authMiddleware, roleMiddleware([Role.ADMIN, Role.MANAGER])];
  const adminDevPreHandler = [authMiddleware, roleMiddleware([Role.ADMIN, Role.DEV])];

  // GET /service-requests/list - Danh sách service requests
  fastify.get('/list', { preHandler: adminPreHandler }, ServiceRequestController.findAll);

  // GET /service-requests/:id - Chi tiết service request
  fastify.get('/:id', { preHandler: authPreHandler }, ServiceRequestController.findOne);

  // GET /service-requests/:id/flexible - Chi tiết với field selection
  // Query: ?fields=id,status,config&include=batches,allocationItems&itemStatus=NEW&itemLimit=100
  fastify.get('/:id/flexible', { preHandler: authPreHandler }, ServiceRequestController.findOneFlexible);

  // POST /service-requests/create - Tạo service request mới
  fastify.post('/create', { preHandler: authPreHandler }, ServiceRequestController.create);

  // PUT /service-requests/update/:id - Cập nhật service request
  fastify.put('/update/:id', { preHandler: authPreHandler }, ServiceRequestController.update);

  // PUT /service-requests/:id/quick-update - Quick update (admin/dev only)
  fastify.put('/:id/quick-update', { preHandler: adminDevPreHandler }, ServiceRequestController.quickUpdate);

  // PUT /service-requests/:id/status - Cập nhật status
  fastify.put('/:id/status', { preHandler: adminPreHandler }, ServiceRequestController.updateStatus);

  // DELETE /service-requests/delete/:id - Soft delete
  fastify.delete('/delete/:id', { preHandler: adminPreHandler }, ServiceRequestController.delete);
};

export default serviceRequestRoutes;
