import { FastifyPluginAsync } from 'fastify';
import { GmailController } from '../../controllers/gmail.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { authOrApiKeyMiddleware } from '../../middlewares/auth-or-apikey.middleware';

const gmailRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  // All routes require authentication
  const authPreHandler = [authMiddleware];
  // Routes that support both auth and API key
  const authOrApiKeyPreHandler = [authOrApiKeyMiddleware];

  // GET /gmails/check-exists - Check if email exists (supports both auth token and PUBLIC_API_KEY)
  fastify.get('/check-exists', { preHandler: authOrApiKeyPreHandler }, GmailController.checkExists);

  // GET /gmails/list - Get all gmails
  fastify.get('/list', { preHandler: authPreHandler }, GmailController.findAll);

  // GET /gmails/detail/:id - Get gmail by ID
  fastify.get('/detail/:id', { preHandler: authPreHandler }, GmailController.findOne);

  // POST /gmails/create - Create new gmail (supports both auth token and PUBLIC_API_KEY)
  fastify.post('/create', { preHandler: authOrApiKeyPreHandler }, GmailController.create);

  // PUT /gmails/update/:id - Update gmail (supports both auth token and PUBLIC_API_KEY)
  fastify.put('/update/:id', { preHandler: authOrApiKeyPreHandler }, GmailController.update);

  // DELETE /gmails/delete/:id - Soft delete gmail
  fastify.delete('/delete/:id', { preHandler: authPreHandler }, GmailController.delete);

  // POST /gmails/restore/:id - Restore gmail from trash
  fastify.post('/restore/:id', { preHandler: authPreHandler }, GmailController.restore);

  // DELETE /gmails/permanent/:id - Permanently delete gmail
  fastify.delete('/permanent/:id', { preHandler: authPreHandler }, GmailController.permanentDelete);

  // POST /gmails/claim-ownership - Claim ownership for multiple gmails
  fastify.post('/claim-ownership', { preHandler: authPreHandler }, GmailController.claimOwnership);

  // POST /gmails/check-usage - Check usage status (does NOT create records)
  fastify.post('/check-usage', { preHandler: authPreHandler }, GmailController.checkUsage);
};

export default gmailRoutes;
