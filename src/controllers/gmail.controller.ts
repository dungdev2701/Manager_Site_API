import { FastifyRequest, FastifyReply } from 'fastify';
import { GmailService } from '../services/gmail.service';
import { ResponseHelper } from '../utils/response';
import {
  createGmailSchema,
  updateGmailSchema,
  gmailQuerySchema,
} from '../validators/gmail.validator';
import { GmailQueryInput } from '../services/gmail.service';

export class GmailController {
  /**
   * Check if email exists
   * GET /gmails/check-exists?email=xxx@gmail.com
   *
   * Supports both JWT auth token and PUBLIC_API_KEY via x-api-key header
   */
  static async checkExists(request: FastifyRequest, reply: FastifyReply) {
    // Note: Authentication is handled by authOrApiKeyMiddleware

    const { email } = request.query as { email?: string };

    if (!email) {
      return ResponseHelper.badRequest(reply, 'email query parameter is required');
    }

    const gmailService = new GmailService(request.server);
    const result = await gmailService.checkEmailExists(email);

    // success: true nếu email tồn tại, false nếu không tồn tại
    return reply.send({
      success: result.exists,
      data: result,
    });
  }

  /**
   * Get all gmails
   * GET /gmails/list
   */
  static async findAll(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate query params
    const query = gmailQuerySchema.parse(request.query) as GmailQueryInput;

    // Get gmails
    const gmailService = new GmailService(request.server);
    const result = await gmailService.getAllGmails(query);

    return ResponseHelper.success(reply, result);
  }

  /**
   * Get gmail by ID
   * GET /gmails/detail/:id
   */
  static async findOne(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const gmailService = new GmailService(request.server);
    const gmail = await gmailService.getGmailById(id);

    if (!gmail) {
      return ResponseHelper.notFound(reply, 'Gmail not found');
    }

    return ResponseHelper.success(reply, gmail);
  }

  /**
   * Create new gmail
   * POST /gmails/create
   *
   * Supports both JWT auth token and PUBLIC_API_KEY via x-api-key header
   */
  static async create(request: FastifyRequest, reply: FastifyReply) {
    // Note: Authentication is handled by authOrApiKeyMiddleware
    // request.user may be undefined when using API key

    // Validate request body
    const validatedData = createGmailSchema.parse(request.body);

    // Create gmail
    const gmailService = new GmailService(request.server);
    const gmail = await gmailService.createGmail(validatedData);

    return ResponseHelper.created(reply, gmail, 'Gmail created successfully');
  }

  /**
   * Update gmail
   * PUT /gmails/update/:id
   *
   * Supports both JWT auth token and PUBLIC_API_KEY via x-api-key header
   */
  static async update(request: FastifyRequest, reply: FastifyReply) {
    // Note: Authentication is handled by authOrApiKeyMiddleware
    // request.user may be undefined when using API key

    const { id } = request.params as { id: string };

    // Validate request body
    const validatedData = updateGmailSchema.parse(request.body);

    // Update gmail
    const gmailService = new GmailService(request.server);
    const gmail = await gmailService.updateGmail(id, validatedData);

    return ResponseHelper.success(reply, gmail, 'Gmail updated successfully');
  }

  /**
   * Delete gmail (soft delete)
   * DELETE /gmails/delete/:id
   */
  static async delete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const gmailService = new GmailService(request.server);
    await gmailService.deleteGmail(id);

    return ResponseHelper.success(reply, null, 'Gmail deleted successfully');
  }

  /**
   * Restore gmail from trash
   * POST /gmails/restore/:id
   */
  static async restore(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const gmailService = new GmailService(request.server);
    const gmail = await gmailService.restoreGmail(id);

    return ResponseHelper.success(reply, gmail, 'Gmail restored successfully');
  }

  /**
   * Permanently delete gmail
   * DELETE /gmails/permanent/:id
   */
  static async permanentDelete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const gmailService = new GmailService(request.server);
    await gmailService.permanentDeleteGmail(id);

    return ResponseHelper.success(reply, null, 'Gmail permanently deleted');
  }

  /**
   * Claim ownership for multiple gmails (used when exporting)
   * POST /gmails/claim-ownership
   */
  static async claimOwnership(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { ids } = request.body as { ids: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return ResponseHelper.badRequest(reply, 'ids must be a non-empty array');
    }

    const gmailService = new GmailService(request.server);
    const result = await gmailService.claimOwnership(ids, request.user.id);

    return ResponseHelper.success(reply, result);
  }

  /**
   * Check usage status for multiple gmails (does NOT create records)
   * POST /gmails/check-usage
   */
  static async checkUsage(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { ids } = request.body as { ids: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return ResponseHelper.badRequest(reply, 'ids must be a non-empty array');
    }

    const gmailService = new GmailService(request.server);
    const result = await gmailService.checkUsageStatus(ids);

    return ResponseHelper.success(reply, result);
  }

  /**
   * Check if email can receive mail (using IMAP with app password)
   * POST /gmails/check-email
   */
  static async checkEmail(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.body as { id: string };

    if (!id) {
      return ResponseHelper.badRequest(reply, 'id is required');
    }

    const gmailService = new GmailService(request.server);

    // Get gmail by id
    const gmail = await gmailService.getGmailById(id);
    if (!gmail) {
      return ResponseHelper.notFound(reply, 'Gmail not found');
    }

    if (!gmail.appPassword) {
      return ResponseHelper.badRequest(reply, 'Gmail does not have an app password');
    }

    // Check email and update status
    const result = await gmailService.checkEmailAndUpdateStatus(
      gmail.id,
      gmail.email,
      gmail.appPassword
    );

    return ResponseHelper.success(reply, result);
  }

  /**
   * Check multiple emails (max 10 at a time)
   * POST /gmails/check-emails
   */
  static async checkEmails(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { ids } = request.body as { ids: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return ResponseHelper.badRequest(reply, 'ids must be a non-empty array');
    }

    if (ids.length > 10) {
      return ResponseHelper.badRequest(reply, 'Maximum 10 emails can be checked at once');
    }

    const gmailService = new GmailService(request.server);
    const results: Array<{
      id: string;
      email: string;
      success: boolean;
      message: string;
      status: string;
    }> = [];

    // Get all gmails
    const gmails = await request.server.prisma.gmail.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
      },
    });

    // Check each email sequentially to avoid rate limiting
    for (const gmail of gmails) {
      if (!gmail.appPassword) {
        results.push({
          id: gmail.id,
          email: gmail.email,
          success: false,
          message: 'No app password',
          status: 'FAILED',
        });
        continue;
      }

      const result = await gmailService.checkEmailAndUpdateStatus(
        gmail.id,
        gmail.email,
        gmail.appPassword
      );

      results.push({
        id: gmail.id,
        email: gmail.email,
        ...result,
      });
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return ResponseHelper.success(reply, {
      results,
      summary: {
        total: results.length,
        success: successCount,
        failed: failCount,
      },
    });
  }
}
