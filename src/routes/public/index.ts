import { FastifyPluginAsync } from 'fastify';
import { apiKeyMiddleware } from '../../middlewares/apikey.middleware';
import { monitorApiKeyMiddleware } from '../../middlewares/monitor.middleware';
import { WebsiteStatus } from '@prisma/client';
import { ToolController } from '../../controllers/tool.controller';

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

  // ==================== TOOLS HEARTBEAT ENDPOINTS ====================

  /**
   * POST /api/public/tools/heartbeat
   *
   * Endpoint cho tools gửi heartbeat để cập nhật trạng thái và cấu hình
   *
   * Body:
   * {
   *   "idTool": "Normal 1",       // Required - Tool identifier
   *   "status": "RUNNING",        // Optional - Default: RUNNING. Values: RUNNING, DIE
   *   "threadNumber": 5,          // Optional - Số luồng
   *   "type": "INDIVIDUAL",       // Optional - Values: INDIVIDUAL, GLOBAL, CANCEL, RE_RUNNING
   *   "service": "ENTITY",        // Optional - Values: ENTITY, SOCIAL, INDEX, GOOGLE_STACKING, BLOG, PODCAST
   *   "estimateTime": 10          // Optional - Thời gian ước tính (phút)
   * }
   *
   * Response:
   * {
   *   "success": true,
   *   "message": "Heartbeat received",
   *   "data": {
   *     "id": "uuid",
   *     "idTool": "Normal 1",
   *     "status": "RUNNING",
   *     "threadNumber": 5,
   *     "type": "INDIVIDUAL",
   *     "service": "ENTITY",
   *     "estimateTime": 10,
   *     "updatedAt": "2024-01-15T10:00:00.000Z"
   *   }
   * }
   *
   * Example:
   * curl -X POST "https://sites.likepion.com/api/public/tools/heartbeat" \
   *   -H "Content-Type: application/json" \
   *   -d '{"idTool": "Normal 1", "threadNumber": 5, "estimateTime": 10}'
   */
  fastify.post('/tools/heartbeat', ToolController.heartbeat);

  // ==================== MONITOR SERVICE ENDPOINTS ====================

  /**
   * POST /api/public/monitor/mark-stale-dead
   *
   * Endpoint cho Monitor Service để đánh dấu tools không update quá estimateTime thành DIE
   * - Mỗi tool có estimateTime riêng (đơn vị: phút)
   * - Nếu tool không có estimateTime → mặc định 5 phút và cập nhật vào DB
   *
   * SECURITY:
   * - API Key PHẢI được gửi qua header x-api-key (Monitor Service API Key)
   *
   * Query params:
   * - staleMinutes (optional): Số phút để xác định tool là stale (default: 5)
   *
   * Response:
   * {
   *   "success": true,
   *   "message": "Marked 3 stale tools as DIE",
   *   "data": {
   *     "markedCount": 3,
   *     "tools": [
   *       { "id": "...", "idTool": "Normal 1", "lastUpdated": "..." }
   *     ]
   *   }
   * }
   */
  fastify.post(
    '/monitor/mark-stale-dead',
    {
      preHandler: monitorApiKeyMiddleware,
    },
    ToolController.markStaleDead
  );

  /**
   * GET /api/public/monitor/health
   *
   * Health check endpoint cho Monitor Service
   */
  fastify.get(
    '/monitor/health',
    {
      preHandler: monitorApiKeyMiddleware,
    },
    async () => {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
    }
  );
};

export default publicRoutes;
