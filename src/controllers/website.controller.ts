import { FastifyRequest, FastifyReply } from 'fastify';
import { WebsiteService } from '../services/website.service';
import { ResponseHelper } from '../utils/response';
import {
  createWebsiteSchema,
  createBulkWebsitesSchema,
  createBulkWebsitesWithMetricsSchema,
  updateWebsiteSchema,
  websiteQuerySchema,
  checkDuplicatesSchema,
  CreateWebsiteDTO,
  CreateBulkWebsitesDTO,
  CreateBulkWebsitesWithMetricsDTO,
  UpdateWebsiteDTO,
  WebsiteQueryDTO,
  CheckDuplicatesDTO,
} from '../validators/website.validator';
import { Role, WebsiteStatus } from '@prisma/client';

export class WebsiteController {
  /**
   * Tạo 1 website
   * POST /websites
   * Permission: ADMIN, MANAGER
   */
  static async create(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Debug log
    console.log('Request body:', request.body);
    console.log('Request body type:', typeof request.body);

    // Validate
    const validatedData: CreateWebsiteDTO = createWebsiteSchema.parse(
      request.body
    );

    // Create
    const websiteService = new WebsiteService(request.server);
    const website = await websiteService.createWebsite(
      validatedData,
      request.user.id // tracking creator
    );

    return ResponseHelper.created(
      reply,
      website,
      'Website created successfully'
    );
  }

  /**
   * Tạo nhiều websites (bulk)
   * POST /websites/bulk
   * Permission: ADMIN, MANAGER
   */
  static async createBulk(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate
    const validatedData: CreateBulkWebsitesDTO =
      createBulkWebsitesSchema.parse(request.body);

    // Create bulk
    const websiteService = new WebsiteService(request.server);
    const result = await websiteService.createBulkWebsites(
      validatedData,
      request.user.id
    );

    return ResponseHelper.created(
      reply,
      result,
      'Websites processed successfully'
    );
  }

  /**
   * Tạo nhiều websites với metrics đầy đủ (bulk import từ Excel)
   * POST /websites/bulk-with-metrics
   * Permission: ADMIN, MANAGER
   */
  static async createBulkWithMetrics(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate
    const validatedData: CreateBulkWebsitesWithMetricsDTO =
      createBulkWebsitesWithMetricsSchema.parse(request.body);

    // Create bulk with metrics
    const websiteService = new WebsiteService(request.server);
    const result = await websiteService.createBulkWebsitesWithMetrics(
      validatedData,
      request.user.id
    );

    return ResponseHelper.created(
      reply,
      result,
      'Websites processed successfully'
    );
  }

  /**
   * Lấy danh sách TẤT CẢ websites với filtering và sorting
   * GET /websites
   * Permission: ALL (ADMIN, MANAGER, DEV, CTV, CHECKER)
   * Note: CTV chỉ xem được websites do chính họ tạo
   */
  static async findAll(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate query params
    const query: WebsiteQueryDTO = websiteQuerySchema.parse(request.query);

    // Get websites (CTV sẽ được filter theo userId)
    const websiteService = new WebsiteService(request.server);
    const result = await websiteService.findAllWebsites({
      page: query.page,
      limit: query.limit,
      type: query.type,
      status: query.status,
      search: query.search,
      // Sort options
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      // Filter by metrics
      index: query.index,
      captcha_type: query.captcha_type,
      captcha_provider: query.captcha_provider,
      required_gmail: query.required_gmail,
      verify: query.verify,
      // Filter by date range
      startDate: query.startDate,
      endDate: query.endDate,
      // User info for role-based filtering
      userId: request.user.id,
      userRole: request.user.role as Role,
    });

    return ResponseHelper.success(reply, result);
  }

  /**
   * Lấy chi tiết 1 website
   * GET /websites/:id
   * Permission: ALL
   * Note: CTV chỉ xem được website do chính họ tạo
   */
  static async findOne(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const websiteService = new WebsiteService(request.server);
    const website = await websiteService.getWebsite(
      id,
      request.user.id,
      request.user.role as Role
    );

    return ResponseHelper.success(reply, website);
  }

  /**
   * Update website
   * PUT /websites/:id
   * Permission: ADMIN, MANAGER, CHECKER
   */
  static async update(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };
    const validatedData: UpdateWebsiteDTO = updateWebsiteSchema.parse(
      request.body
    );

    const websiteService = new WebsiteService(request.server);
    const website = await websiteService.updateWebsite(
      id,
      validatedData,
      request.user.id,
      request.user.role as Role,
      {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      }
    );

    return ResponseHelper.success(
      reply,
      website,
      'Website updated successfully'
    );
  }

  /**
   * Soft delete website (xóa mềm)
   * DELETE /websites/:id
   * Permission: ADMIN only
   */
  static async delete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const websiteService = new WebsiteService(request.server);
    const result = await websiteService.deleteWebsite(id);

    return ResponseHelper.success(reply, result, 'Website moved to trash');
  }

  /**
   * Khôi phục website đã bị xóa mềm
   * POST /websites/restore/:id
   * Permission: ADMIN only
   */
  static async restore(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const websiteService = new WebsiteService(request.server);
    const website = await websiteService.restoreWebsite(id);

    return ResponseHelper.success(reply, website, 'Website restored successfully');
  }

  /**
   * Lấy danh sách websites đã bị xóa (trash)
   * GET /websites/trash
   * Permission: ADMIN only
   */
  static async findDeleted(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const query: WebsiteQueryDTO = websiteQuerySchema.parse(request.query);

    const websiteService = new WebsiteService(request.server);
    const result = await websiteService.findDeletedWebsites({
      page: query.page,
      limit: query.limit,
      search: query.search,
    });

    return ResponseHelper.success(reply, result);
  }

  /**
   * Xóa vĩnh viễn website
   * DELETE /websites/permanent/:id
   * Permission: ADMIN only
   */
  static async permanentDelete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const websiteService = new WebsiteService(request.server);
    await websiteService.permanentlyDeleteWebsite(id);

    return ResponseHelper.success(reply, null, 'Website permanently deleted');
  }

  /**
   * Thống kê websites (toàn hệ thống)
   * GET /websites/statistics
   * Permission: ALL
   */
  static async statistics(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const websiteService = new WebsiteService(request.server);
    const stats = await websiteService.getStatistics();

    return ResponseHelper.success(reply, stats);
  }

  /**
   * Bulk update status cho nhiều websites
   * PATCH /websites/bulk/status
   * Permission: ADMIN, MANAGER
   */
  static async bulkUpdateStatus(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { ids, status } = request.body as { ids: string[]; status: string };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return ResponseHelper.badRequest(reply, 'IDs array is required');
    }

    if (!status) {
      return ResponseHelper.badRequest(reply, 'Status is required');
    }

    const validStatuses = ['NEW', 'CHECKING', 'HANDING', 'PENDING', 'RUNNING', 'ERROR', 'MAINTENANCE'];
    if (!validStatuses.includes(status)) {
      return ResponseHelper.badRequest(reply, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }

    const websiteService = new WebsiteService(request.server);
    const result = await websiteService.bulkUpdateStatus(ids, status as WebsiteStatus);

    return ResponseHelper.success(reply, result, `Updated ${result.updated} websites`);
  }

  /**
   * Lấy tất cả website IDs dựa trên filter (để hỗ trợ Select All)
   * GET /websites/all-ids
   * Permission: ALL
   * Note: CTV chỉ lấy được IDs của websites do chính họ tạo
   */
  static async getAllIds(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate query params (same as findAll but without pagination)
    const query: WebsiteQueryDTO = websiteQuerySchema.parse(request.query);

    const websiteService = new WebsiteService(request.server);
    const ids = await websiteService.getAllWebsiteIds({
      type: query.type,
      status: query.status,
      search: query.search,
      index: query.index,
      captcha_type: query.captcha_type,
      captcha_provider: query.captcha_provider,
      required_gmail: query.required_gmail,
      verify: query.verify,
      // User info for role-based filtering
      userId: request.user.id,
      userRole: request.user.role as Role,
    });

    return ResponseHelper.success(reply, { ids, total: ids.length });
  }

  /**
   * Lấy nhiều websites theo IDs (để export)
   * POST /websites/by-ids
   * Permission: ALL
   */
  static async getByIds(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { ids } = request.body as { ids: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return ResponseHelper.badRequest(reply, 'IDs array is required');
    }

    if (ids.length > 5000) {
      return ResponseHelper.badRequest(reply, 'Maximum 5000 IDs allowed');
    }

    const websiteService = new WebsiteService(request.server);
    const websites = await websiteService.getWebsitesByIds(ids);

    return ResponseHelper.success(reply, { websites, total: websites.length });
  }

  /**
   * Đối chiếu list domain với toàn bộ hệ thống
   * POST /websites/check-duplicates
   * Permission: ALL can view
   */
  static async checkDuplicates(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const validatedData: CheckDuplicatesDTO = checkDuplicatesSchema.parse(request.body);

    const websiteService = new WebsiteService(request.server);
    const result = await websiteService.checkDuplicates(validatedData.domains);

    return ResponseHelper.success(reply, result);
  }

  /**
   * Lọc domains theo RUNNING websites trong hệ thống
   * POST /websites/filter-domains
   * Permission: ALL can view
   */
  static async filterDomains(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { domains, serviceType } = request.body as { domains: string[]; serviceType: string };

    if (!domains || !Array.isArray(domains) || domains.length === 0) {
      return ResponseHelper.badRequest(reply, 'Domains array is required');
    }

    if (!serviceType) {
      return ResponseHelper.badRequest(reply, 'serviceType is required');
    }

    const websiteService = new WebsiteService(request.server);
    const result = await websiteService.filterRunningDomains(domains, serviceType);

    return ResponseHelper.success(reply, result);
  }
}
