import { FastifyPluginAsync } from 'fastify';
import { apiKeyMiddleware } from '../../middlewares/apikey.middleware';
import { WebsiteStatus, WebsiteType } from '@prisma/client';

// Valid values for validation
const VALID_TYPES = Object.values(WebsiteType);
const VALID_STATUSES = Object.values(WebsiteStatus);

const publicRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {

  /**
   * GET /api/public/websites
   *
   * Public endpoint để lấy danh sách domains
   * Yêu cầu API Key qua header (x-api-key) hoặc query (?apikey=)
   *
   * Query params:
   * - type: WebsiteType (ENTITY, GG_STACKING, etc.)
   * - status: WebsiteStatus (NEW, RUNNING, etc.)
   *
   * Response: string[] (mảng domain)
   */
  fastify.get<{
    Querystring: {
      type?: string;
      status?: string;
      apikey?: string;
    };
  }>(
    '/websites',
    { preHandler: apiKeyMiddleware },
    async (request, reply) => {
      const { type, status } = request.query;

      // Validate type
      if (type && !VALID_TYPES.includes(type as WebsiteType)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: `Invalid type. Valid values: ${VALID_TYPES.join(', ')}`,
        });
      }

      // Validate status
      if (status && !VALID_STATUSES.includes(status as WebsiteStatus)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: `Invalid status. Valid values: ${VALID_STATUSES.join(', ')}`,
        });
      }

      // Build where clause
      const where: {
        deletedAt: null;
        types?: { has: WebsiteType };
        status?: WebsiteStatus;
      } = {
        deletedAt: null,
      };

      if (type) {
        where.types = { has: type as WebsiteType };
      }
      if (status) {
        where.status = status as WebsiteStatus;
      }

      // Fetch only domains
      const websites = await fastify.prisma.website.findMany({
        where,
        select: {
          domain: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      // Return array of domains
      return websites.map((w) => w.domain);
    }
  );
};

export default publicRoutes;
