import { FastifyPluginAsync } from 'fastify';
import { AuthController } from '../../controllers/auth.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';

const authRoutes: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  // Public routes (không cần authentication)
  fastify.post('/register', AuthController.register);
  fastify.post('/login', AuthController.login);
  fastify.post('/refresh', AuthController.refreshToken);

  // Protected routes (cần authentication)
  fastify.get('/me', { preHandler: [authMiddleware] }, AuthController.getProfile);
  fastify.put('/profile', { preHandler: [authMiddleware] }, AuthController.updateProfile);
  fastify.put('/change-password', { preHandler: [authMiddleware] }, AuthController.changePassword);
};

export default authRoutes;
