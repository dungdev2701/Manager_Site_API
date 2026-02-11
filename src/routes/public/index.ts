import { FastifyPluginAsync } from 'fastify';
import { apiKeyMiddleware } from '../../middlewares/apikey.middleware';
import { monitorApiKeyMiddleware } from '../../middlewares/monitor.middleware';
import { authOrApiKeyMiddleware } from '../../middlewares/auth-or-apikey.middleware';
import { WebsiteStatus } from '@prisma/client';
import { ToolController } from '../../controllers/tool.controller';
import { ServiceRequestController } from '../../controllers/service-request.controller';
import { AllocationTaskController } from '../../controllers/allocation-task.controller';

// In-memory cache for public websites endpoint
// Key: "type:captcha_type" (e.g. "ENTITY:normal", "ENTITY:captcha", "ENTITY:all")
// Value: { data: string[], timestamp: number }
const websiteCache = new Map<string, { data: string[]; timestamp: number }>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

// Valid captcha_type values
type CaptchaType = 'normal' | 'captcha';

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
   * Query params:
   * - captcha_type: 'normal' | 'captcha' (optional) - Filter by captcha type
   *
   * Response: string[] (mảng domain)
   *
   * Example:
   * curl -H "x-api-key: lkp_blog2_xxx" "https://sites.likepion.com/api/public/websites"
   * -> Trả về danh sách BLOG2 websites với status=RUNNING
   *
   * curl -H "x-api-key: lkp_entity_xxx" "https://sites.likepion.com/api/public/websites?captcha_type=normal"
   * -> Trả về danh sách ENTITY websites với captcha_type=normal
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

      // Get captcha_type from query params
      const { captcha_type } = request.query as { captcha_type?: CaptchaType };

      // Validate captcha_type if provided
      if (captcha_type && captcha_type !== 'normal' && captcha_type !== 'captcha') {
        return { error: 'Invalid captcha_type. Must be "normal" or "captcha"' };
      }

      // Build cache key: "type:captcha_type" (e.g. "ENTITY:normal", "ENTITY:all")
      const cacheKey = `${allowedType}:${captcha_type || 'all'}`;

      // Check cache first
      const cached = websiteCache.get(cacheKey);
      const now = Date.now();
      if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
      }

      // Build where clause
      const whereClause: {
        deletedAt: null;
        types: { has: typeof allowedType };
        status: typeof WebsiteStatus.RUNNING;
        metrics?: { path: string[]; equals: string };
      } = {
        deletedAt: null,
        types: { has: allowedType },
        status: WebsiteStatus.RUNNING,
      };

      // Add captcha_type filter if provided
      if (captcha_type) {
        whereClause.metrics = {
          path: ['captcha_type'],
          equals: captcha_type,
        };
      }

      // Query database
      const websites = await fastify.prisma.website.findMany({
        where: whereClause,
        select: {
          domain: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      // Cache result
      const domains = websites.map((w) => w.domain);
      websiteCache.set(cacheKey, { data: domains, timestamp: now });

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
   * Query params:
   * - captcha_type: 'normal' | 'captcha' (optional) - Filter by captcha type
   *
   * Response:
   * {
   *   "type": "BLOG2",
   *   "captcha_type": "normal",
   *   "count": 100
   * }
   *
   * Example:
   * curl -H "x-api-key: lkp_blog2_xxx" "https://sites.likepion.com/api/public/websites/count"
   * curl -H "x-api-key: lkp_entity_xxx" "https://sites.likepion.com/api/public/websites/count?captcha_type=normal"
   */
  fastify.get(
    '/websites/count',
    {
      preHandler: apiKeyMiddleware,
      config: { rateLimit: PUBLIC_RATE_LIMIT },
    },
    async (request) => {
      const allowedType = request.allowedType!;

      // Get captcha_type from query params
      const { captcha_type } = request.query as { captcha_type?: CaptchaType };

      // Validate captcha_type if provided
      if (captcha_type && captcha_type !== 'normal' && captcha_type !== 'captcha') {
        return { error: 'Invalid captcha_type. Must be "normal" or "captcha"' };
      }

      // Build where clause
      const whereClause: {
        deletedAt: null;
        types: { has: typeof allowedType };
        status: typeof WebsiteStatus.RUNNING;
        metrics?: { path: string[]; equals: string };
      } = {
        deletedAt: null,
        types: { has: allowedType },
        status: WebsiteStatus.RUNNING,
      };

      // Add captcha_type filter if provided
      if (captcha_type) {
        whereClause.metrics = {
          path: ['captcha_type'],
          equals: captcha_type,
        };
      }

      // Đếm số lượng websites RUNNING
      const count = await fastify.prisma.website.count({
        where: whereClause,
      });

      return {
        type: allowedType,
        ...(captcha_type && { captcha_type }),
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

  // ==================== SERVICE REQUEST ENDPOINTS (KH websites) ====================

  /**
   * POST /api/public/service-requests/create
   *
   * KH website gọi API để tạo service request mới
   * Xác thực: JWT token hoặc PUBLIC_API_KEY
   */
  fastify.post(
    '/service-requests/create',
    { preHandler: authOrApiKeyMiddleware },
    ServiceRequestController.createFromExternal
  );

  /**
   * GET /api/public/service-requests/by-status/:status
   *
   * Monitor/Allocation service lấy requests theo status
   * Xác thực: Monitor API Key
   */
  fastify.get(
    '/service-requests/by-status/:status',
    { preHandler: monitorApiKeyMiddleware },
    ServiceRequestController.findByStatus
  );

  /**
   * GET /api/public/service-requests/external/:serviceType/:externalId
   *
   * Lấy request theo externalId + serviceType (dùng cho sync từ KH)
   * Xác thực: JWT token hoặc PUBLIC_API_KEY
   */
  fastify.get(
    '/service-requests/external/:serviceType/:externalId',
    { preHandler: authOrApiKeyMiddleware },
    ServiceRequestController.findByExternalId
  );

  /**
   * PUT /api/public/service-requests/:id/status
   *
   * Cập nhật status từ monitor/allocation service
   * Xác thực: Monitor API Key
   */
  fastify.put(
    '/service-requests/:id/status',
    { preHandler: monitorApiKeyMiddleware },
    ServiceRequestController.updateStatusExternal
  );

  /**
   * PUT /api/public/service-requests/:id/progress
   *
   * Cập nhật tiến độ (totalLinks, completedLinks, failedLinks)
   * Xác thực: Monitor API Key
   */
  fastify.put(
    '/service-requests/:id/progress',
    { preHandler: monitorApiKeyMiddleware },
    ServiceRequestController.updateProgress
  );

  // ==================== ALLOCATION TASK ENDPOINTS (Tools) ====================
  // Endpoints cho tools để claim và complete tasks

  const allocationController = new AllocationTaskController(fastify);

  // Tool rate limit: Higher limit for automation
  const TOOL_RATE_LIMIT = { max: 1000, timeWindow: '1 minute' };

  /**
   * POST /api/public/allocation-tasks/claim
   *
   * Tools gọi để claim pending tasks
   *
   * Body:
   * {
   *   "toolId": "Normal 1;Captcha 1",  // Required - phải khớp với idTool trong bảng tools
   *   "serviceType": "ENTITY",          // Optional filter
   *   "limit": 10,                      // Optional, default 10
   *   "supportedDomains": ["site1.com", "site2.com"],  // Optional: array or comma-separated string "site1.com,site2.com"
   *   "includeConnecting": true         // Optional: also claim CONNECTING tasks for stacking
   * }
   *
   * Tool type logic (từ bảng tools.type):
   * - GLOBAL: Claim tất cả tasks (request.idTool is NULL hoặc matches toolId)
   * - INDIVIDUAL: Chỉ claim tasks mà request.idTool khớp chính xác với toolId
   *
   * Status flow:
   * - NEW tasks → REGISTERING (tool does registration/profiling)
   * - CONNECTING tasks → remains CONNECTING (tool does stacking)
   *
   * Response:
   * {
   *   "success": true,
   *   "message": "Claimed 5 tasks",
   *   "data": {
   *     "count": 5,
   *     "items": [
   *       { "id": "uuid", "domain": "example.com", "serviceType": "ENTITY", "linkData": {...} }
   *     ]
   *   }
   * }
   */
  fastify.post(
    '/allocation-tasks/claim',
    { config: { rateLimit: TOOL_RATE_LIMIT } },
    allocationController.claimTasks.bind(allocationController)
  );

  /**
   * POST /api/public/allocation-tasks/:itemId/complete
   *
   * Tools gọi khi hoàn thành một task
   *
   * Body:
   * {
   *   "success": true,
   *   "linkProfile": "https://example.com/profile/123",
   *   "linkPost": "https://example.com/post/456",
   *   "errorCode": "CAPTCHA_FAILED",      // If success=false
   *   "errorMessage": "Failed to solve"   // If success=false
   * }
   */
  fastify.post(
    '/allocation-tasks/:itemId/complete',
    { config: { rateLimit: TOOL_RATE_LIMIT } },
    allocationController.completeTask.bind(allocationController)
  );

  /**
   * PUT /api/public/allocation-tasks/:itemId/status
   *
   * Cập nhật status của allocation item một cách linh hoạt
   * Cho phép set bất kỳ status hợp lệ nào
   *
   * Body:
   * {
   *   "status": "REGISTERING",           // Required - AllocationItemStatus enum
   *   "linkProfile": "https://...",      // Optional
   *   "linkPost": "https://...",         // Optional
   *   "note": "Some note",               // Optional
   *   "errorCode": "ERROR_CODE",         // Optional
   *   "errorMessage": "Error details"    // Optional
   * }
   *
   * Valid statuses:
   * - NEW, REGISTERING, PROFILING, CONNECT, CONNECTING
   * - FAIL_REGISTERING, FAIL_PROFILING, FAIL_CONNECTING
   * - CANCEL, FINISH, PENDING, CLAIMED, SUCCESS, FAILED
   */
  fastify.put(
    '/allocation-tasks/:itemId/status',
    { config: { rateLimit: TOOL_RATE_LIMIT } },
    allocationController.updateTaskStatus.bind(allocationController)
  );

  /**
   * GET /api/public/allocation-tasks/pending
   *
   * Tools xem pending tasks (không claim)
   *
   * Query:
   * - toolId: Required
   * - serviceType: Optional filter
   */
  fastify.get(
    '/allocation-tasks/pending',
    { config: { rateLimit: TOOL_RATE_LIMIT } },
    allocationController.getPendingTasks.bind(allocationController)
  );

  // ==================== ALLOCATION TASK MONITOR ENDPOINTS ====================
  // Endpoints cho Monitor Service

  /**
   * POST /api/public/allocation-tasks/process
   *
   * Monitor Service gọi để trigger allocation cho NEW requests
   * Xác thực: Monitor API Key
   */
  fastify.post(
    '/allocation-tasks/process',
    { preHandler: monitorApiKeyMiddleware },
    allocationController.processNewRequests.bind(allocationController)
  );

  /**
   * POST /api/public/allocation-tasks/release-expired
   *
   * Monitor Service gọi để release expired claims
   * Xác thực: Monitor API Key
   */
  fastify.post(
    '/allocation-tasks/release-expired',
    { preHandler: monitorApiKeyMiddleware },
    allocationController.releaseExpiredClaims.bind(allocationController)
  );

  /**
   * POST /api/public/allocation-tasks/timeout-requests
   *
   * Monitor Service gọi để timeout các requests đã hết thời gian hoàn thành
   * - entityLimit >= 100: timeout = (entityLimit / 100) * REQUEST_COMPLETION_TIME_PER_100
   * - entityLimit < 100: timeout = 30 phút (cố định, ưu tiên hoàn thành)
   * Xác thực: Monitor API Key
   */
  fastify.post(
    '/allocation-tasks/timeout-requests',
    { preHandler: monitorApiKeyMiddleware },
    allocationController.timeoutExpiredRequests.bind(allocationController)
  );

  /**
   * POST /api/public/allocation-tasks/trigger-stacking
   *
   * Monitor Service gọi để trigger stacking cho requests đạt threshold
   *
   * Logic kiểm tra:
   * - entityConnect = 'all': linkProfile count >= entityLimit → trigger stacking
   * - entityConnect = 'limit': linkProfile count >= limit value → trigger stacking
   *
   * Khi đạt threshold:
   * - Chuyển status từ CONNECT → CONNECTING
   * - Tools có thể claim CONNECTING tasks để thực hiện stacking
   *
   * Status flow:
   * - CONNECT: Đang chờ đủ điều kiện stacking (không thể claim)
   * - CONNECTING: Sẵn sàng stacking (tool có thể claim với includeConnecting=true)
   *
   * Xác thực: Monitor API Key
   *
   * Response:
   * {
   *   "success": true,
   *   "message": "Triggered stacking for 2 requests, updated 50 items",
   *   "data": {
   *     "triggered": 2,
   *     "updatedItems": 50,
   *     "details": [
   *       { "requestId": "...", "entityConnect": "all", "threshold": 100, "linkProfileCount": 105 }
   *     ]
   *   }
   * }
   */
  fastify.post(
    '/allocation-tasks/trigger-stacking',
    { preHandler: monitorApiKeyMiddleware },
    allocationController.triggerStackingForReadyRequests.bind(allocationController)
  );

  /**
   * GET /api/public/allocation-tasks/statistics
   *
   * Lấy statistics (dùng cho monitoring dashboard)
   * Xác thực: Monitor API Key
   */
  fastify.get(
    '/allocation-tasks/statistics',
    { preHandler: monitorApiKeyMiddleware },
    allocationController.getStatistics.bind(allocationController)
  );

  /**
   * GET /api/public/service-requests/:id
   *
   * Lấy thông tin service request với field selection linh hoạt
   * Xác thực: Monitor API Key (x-api-key: lkp_monitor_xxx)
   *
   * Query params:
   * - fields: Comma-separated field names or 'all' (default: 'all')
   *   Available: id, externalUserId, externalUserEmail, externalUserName, assignedUserId,
   *              serviceType, serviceGroupId, externalId, name, typeRequest, target,
   *              auctionPrice, domains, config, idTool, runCount, status, createdAt, updatedAt
   *   Example: ?fields=id,status,config,runCount
   *
   * - include: Comma-separated relation names
   *   Available: assignedUser, batches, allocationItems
   *   Example: ?include=batches,allocationItems
   *
   * - itemStatus: Filter allocation items by status (comma-separated)
   *   Example: ?itemStatus=NEW,REGISTERING
   *
   * - itemLimit: Limit number of allocation items (1-1000)
   *   Example: ?itemLimit=100
   *
   * Full example:
   * GET /api/public/service-requests/abc123?fields=id,status,config&include=allocationItems&itemStatus=NEW&itemLimit=50
   *
   * Response:
   * {
   *   "success": true,
   *   "data": {
   *     "id": "abc123",
   *     "status": "RUNNING",
   *     "config": {...},
   *     "allocationItems": [...]
   *   }
   * }
   */
  fastify.get(
    '/service-requests/:id',
    { preHandler: monitorApiKeyMiddleware },
    ServiceRequestController.findOneFlexible
  );
};

export default publicRoutes;
