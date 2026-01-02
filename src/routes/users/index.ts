import { FastifyPluginAsync } from 'fastify';
import { UserController } from '../../controllers/user.controller';
import { authMiddleware, roleMiddleware } from '../../middlewares/auth.middleware';
import { Role } from '@prisma/client';

const userRoutes: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  // All routes require authentication and ADMIN role
  const adminPreHandler = [authMiddleware, roleMiddleware([Role.ADMIN])];

  // GET /users - Get all users
  fastify.get('/list', { preHandler: adminPreHandler }, UserController.findAll);

  // GET /users/:id - Get user by ID
  fastify.get('/:id', { preHandler: adminPreHandler }, UserController.findOne);

  // POST /users - Create new user
  fastify.post('/create', { preHandler: adminPreHandler }, UserController.create);

  // PUT /users/:id - Update user
  fastify.put('/update/:id', { preHandler: adminPreHandler }, UserController.update);

  // PUT /users/:id/reset-password - Reset user password
  fastify.put('/:id/reset-password', { preHandler: adminPreHandler }, UserController.resetPassword);

  // DELETE /users/:id - Soft delete (deactivate) user
  fastify.delete('/delete/:id', { preHandler: adminPreHandler }, UserController.delete);

  // DELETE /users/:id/permanent - Permanently delete user
  fastify.delete('/permanent/:id', { preHandler: adminPreHandler }, UserController.permanentDelete);

  // POST /users/:id/activate - Activate user
  fastify.post('/:id/activate', { preHandler: adminPreHandler }, UserController.activate);

  // POST /users/:id/deactivate - Deactivate user
  fastify.post('/:id/deactivate', { preHandler: adminPreHandler }, UserController.deactivate);
};

export default userRoutes;
