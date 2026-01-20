import { FastifyPluginAsync } from 'fastify';
import { ToolController } from '../../controllers/tool.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';

const toolRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  // All routes require authentication
  const authPreHandler = [authMiddleware];

  // GET /tools/list - Get all tools
  fastify.get('/list', { preHandler: authPreHandler }, ToolController.findAll);

  // GET /tools/detail/:id - Get tool by ID
  fastify.get('/detail/:id', { preHandler: authPreHandler }, ToolController.findOne);

  // POST /tools/create - Create new tool
  fastify.post('/create', { preHandler: authPreHandler }, ToolController.create);

  // PUT /tools/update/:id - Update tool
  fastify.put('/update/:id', { preHandler: authPreHandler }, ToolController.update);

  // DELETE /tools/delete/:id - Soft delete tool
  fastify.delete('/delete/:id', { preHandler: authPreHandler }, ToolController.delete);

  // POST /tools/restore/:id - Restore tool from trash
  fastify.post('/restore/:id', { preHandler: authPreHandler }, ToolController.restore);

  // DELETE /tools/permanent/:id - Permanently delete tool
  fastify.delete('/permanent/:id', { preHandler: authPreHandler }, ToolController.permanentDelete);
};

export default toolRoutes;
