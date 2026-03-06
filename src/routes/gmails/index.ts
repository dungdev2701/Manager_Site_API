import { FastifyPluginAsync } from 'fastify';
import { GmailController } from '../../controllers/gmail.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { authOrApiKeyMiddleware } from '../../middlewares/auth-or-apikey.middleware';

const gmailRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  // Allow empty body for any content-type (some external clients send POST without body)
  fastify.addContentTypeParser('application/x-www-form-urlencoded', (_req, _payload, done) => {
    done(null, {});
  });
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const str = (body as string).trim();
        done(null, str ? JSON.parse(str) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // All routes require authentication
  const authPreHandler = [authMiddleware];
  // Routes that support both auth and API key
  const authOrApiKeyPreHandler = [authOrApiKeyMiddleware];

  // GET /gmails/check-exists - Check if email exists (supports both auth token and PUBLIC_API_KEY)
  fastify.get('/check-exists', { preHandler: authOrApiKeyPreHandler }, GmailController.checkExists);

  // GET /gmails/get-by-email - Get gmail info by email (supports both auth token and PUBLIC_API_KEY)
  fastify.get('/get-by-email', { preHandler: authOrApiKeyPreHandler }, GmailController.getByEmail);

  // GET /gmails/list - Get all gmails
  fastify.get('/list', { preHandler: authPreHandler }, GmailController.findAll);

  // GET /gmails/detail/:id - Get gmail by ID
  fastify.get('/detail/:id', { preHandler: authPreHandler }, GmailController.findOne);

  // POST /gmails/create - Create new gmail (supports both auth token and PUBLIC_API_KEY)
  fastify.post('/create', { preHandler: authOrApiKeyPreHandler }, GmailController.create);

  // POST /gmails/create-bulk - Bulk create gmails
  fastify.post('/create-bulk', { preHandler: authPreHandler }, GmailController.bulkCreate);

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

  // POST /gmails/claim - Atomic claim emails NEW → RUNNING (supports both auth token and PUBLIC_API_KEY)
  fastify.post('/claim', {
    preHandler: authOrApiKeyPreHandler,
    schema: { body: { type: 'object', nullable: true } },
  }, GmailController.claim);

  // POST /gmails/check-email - Check single email can receive mail
  fastify.post('/check-email', { preHandler: authPreHandler }, GmailController.checkEmail);

  // POST /gmails/check-emails - Check multiple emails (max 10)
  fastify.post('/check-emails', { preHandler: authPreHandler }, GmailController.checkEmails);
};

export default gmailRoutes;
