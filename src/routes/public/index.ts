import { FastifyPluginAsync } from 'fastify';
import { apiKeyMiddleware } from '../../middlewares/apikey.middleware';
import { WebsiteStatus } from '@prisma/client';

// In-memory cache for public websites endpoint
// Key: WebsiteType, Value: { data: string[], timestamp: number }
const websiteCache = new Map<string, { data: string[]; timestamp: number }>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

// Rate limit: 10 requests per minute per API key
const PUBLIC_RATE_LIMIT = { max: 600, timeWindow: '1 minute' };

const publicRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {

  /**
   * GET /api/public/websites
   *
   * Public endpoint để lấy danh sách domains
   *
   * SECURITY:
   * - API Key PHẢI được gửi qua header x-api-key (KHÔNG qua URL query)
   * - Mỗi API key chỉ được phép truy cập 1 type cụ thể (ENTITY, BLOG2, PODCAST, etc.)
   * - Chỉ trả về websites có status=RUNNING
   *
   * PERFORMANCE:
   * - Results are cached for 1 minute to reduce database load
   * - Rate limited: 10 requests per minute per API key
   *
   * Response: string[] (mảng domain)
   *
   * Example:
   * curl -H "x-api-key: lkp_blog2_xxx" "https://sites.likepion.com/api/public/websites"
   * -> Trả về danh sách BLOG2 websites với status=RUNNING
   */
  fastify.get(
    '/websites',
    {
      preHandler: apiKeyMiddleware,
      config: { rateLimit: PUBLIC_RATE_LIMIT },
    },
    async (request) => {
      // Type và status được xác định từ API key
      // - Type: từ request.allowedType (set bởi middleware)
      // - Status: luôn là RUNNING (bắt buộc)
      const allowedType = request.allowedType!;

      // Check cache first
      const cached = websiteCache.get(allowedType);
      const now = Date.now();
      if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
      }

      // Query database
      const websites = await fastify.prisma.website.findMany({
        where: {
          deletedAt: null,
          types: { has: allowedType },
          status: WebsiteStatus.RUNNING,
        },
        select: {
          domain: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      // Cache result
      const domains = websites.map((w) => w.domain);
      websiteCache.set(allowedType, { data: domains, timestamp: now });

      return domains;
    }
  );

  /**
   * GET /api/public/websites/count
   *
   * Public endpoint để lấy số lượng domains đang RUNNING
   *
   * SECURITY:
   * - API Key PHẢI được gửi qua header x-api-key (KHÔNG qua URL query)
   * - Mỗi API key chỉ được phép xem count của type tương ứng
   * - Chỉ trả về số lượng websites có status=RUNNING
   *
   * Response:
   * {
   *   "type": "BLOG2",
   *   "count": 100
   * }
   *
   * Example:
   * curl -H "x-api-key: lkp_blog2_xxx" "https://sites.likepion.com/api/public/websites/count"
   */
  fastify.get(
    '/websites/count',
    {
      preHandler: apiKeyMiddleware,
      config: { rateLimit: PUBLIC_RATE_LIMIT },
    },
    async (request) => {
      const allowedType = request.allowedType!;

      // Đếm số lượng websites RUNNING
      const count = await fastify.prisma.website.count({
        where: {
          deletedAt: null,
          types: { has: allowedType },
          status: WebsiteStatus.RUNNING,
        },
      });

      return {
        type: allowedType,
        count,
      };
    }
  );
};

export default publicRoutes;
