import { FastifyRequest, FastifyReply } from 'fastify';
import { ServiceRequestService } from '../services/service-request.service';
import { ResponseHelper } from '../utils/response';
import {
  createServiceRequestSchema,
  updateServiceRequestSchema,
  updateStatusSchema,
  quickUpdateSchema,
  serviceRequestQuerySchema,
  flexibleFindByIdSchema,
} from '../validators/service-request.validator';

export class ServiceRequestController {
  /**
   * Tạo service request mới
   * POST /service-requests/create
   */
  static async create(request: FastifyRequest, reply: FastifyReply) {
    const body = createServiceRequestSchema.parse(request.body);

    const service = new ServiceRequestService(request.server);
    const result = await service.create(body);

    return ResponseHelper.created(reply, result, 'Service request created');
  }

  /**
   * Tạo service request từ hệ thống KH (public API với API key)
   * POST /public/service-requests/create
   */
  static async createFromExternal(request: FastifyRequest, reply: FastifyReply) {
    const body = createServiceRequestSchema.parse(request.body);

    const service = new ServiceRequestService(request.server);
    const result = await service.create(body);

    return ResponseHelper.created(reply, result, 'Service request created');
  }

  /**
   * Lấy danh sách service requests
   * GET /service-requests/list
   */
  static async findAll(request: FastifyRequest, reply: FastifyReply) {
    const query = serviceRequestQuerySchema.parse(request.query);

    const service = new ServiceRequestService(request.server);
    const result = await service.findAll(query);

    return ResponseHelper.successWithPagination(
      reply,
      result.data,
      { page: result.page, limit: result.limit, total: result.total }
    );
  }

  /**
   * Lấy service request theo ID
   * GET /service-requests/:id
   */
  static async findOne(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };

    const service = new ServiceRequestService(request.server);
    const result = await service.findById(id);

    return ResponseHelper.success(reply, result);
  }

  /**
   * Lấy service request theo ID với field selection linh hoạt
   * GET /service-requests/:id/flexible
   *
   * Query params:
   * - fields: Comma-separated field names or 'all' (default: 'all')
   *   Example: ?fields=id,status,config,runCount
   * - include: Comma-separated relation names
   *   Available: assignedUser, batches, allocationItems
   *   Example: ?include=batches,allocationItems
   * - itemStatus: Filter allocation items by status (comma-separated)
   *   Example: ?itemStatus=NEW,REGISTERING
   * - itemLimit: Limit number of allocation items (1-1000)
   *   Example: ?itemLimit=100
   *
   * Full example:
   * GET /service-requests/abc123/flexible?fields=id,status,config&include=allocationItems&itemStatus=NEW&itemLimit=50
   */
  static async findOneFlexible(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const query = flexibleFindByIdSchema.parse(request.query);

    const service = new ServiceRequestService(request.server);
    const result = await service.findByIdFlexible(id, query);

    return ResponseHelper.success(reply, result);
  }

  /**
   * Update service request
   * PUT /service-requests/update/:id
   */
  static async update(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const body = updateServiceRequestSchema.parse(request.body);

    const service = new ServiceRequestService(request.server);
    const result = await service.update(id, body);

    return ResponseHelper.success(reply, result, 'Service request updated');
  }

  /**
   * Cập nhật status
   * PUT /service-requests/:id/status
   */
  static async updateStatus(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const { status } = updateStatusSchema.parse(request.body);

    const service = new ServiceRequestService(request.server);
    const result = await service.updateStatus(id, status);

    return ResponseHelper.success(reply, result, 'Status updated');
  }

  /**
   * Quick update (admin/dev only)
   * PUT /service-requests/:id/quick-update
   */
  static async quickUpdate(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const body = quickUpdateSchema.parse(request.body);

    const service = new ServiceRequestService(request.server);
    const result = await service.quickUpdate(id, body);

    return ResponseHelper.success(reply, result, 'Service request updated');
  }

  /**
   * Soft delete service request
   * DELETE /service-requests/delete/:id
   */
  static async delete(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };

    const service = new ServiceRequestService(request.server);
    await service.delete(id);

    return ResponseHelper.success(reply, null, 'Service request deleted');
  }

  /**
   * Lấy requests theo status (dùng cho monitor/allocation)
   * GET /public/service-requests/by-status/:status
   */
  static async findByStatus(request: FastifyRequest, reply: FastifyReply) {
    const { status } = request.params as { status: string };
    const { serviceType } = request.query as { serviceType?: string };

    const service = new ServiceRequestService(request.server);
    const result = await service.findByStatus(
      status as any,
      serviceType as any
    );

    return ResponseHelper.success(reply, result);
  }

  /**
   * Lấy request theo externalId (dùng cho sync từ KH)
   * GET /public/service-requests/external/:serviceType/:externalId
   */
  static async findByExternalId(request: FastifyRequest, reply: FastifyReply) {
    const { serviceType, externalId } = request.params as {
      serviceType: string;
      externalId: string;
    };

    const service = new ServiceRequestService(request.server);
    const result = await service.findByExternalId(externalId, serviceType as any);

    if (!result) {
      return ResponseHelper.notFound(reply, 'ServiceRequest not found');
    }

    return ResponseHelper.success(reply, result);
  }

  /**
   * Cập nhật status từ hệ thống bên ngoài (public API)
   * PUT /public/service-requests/:id/status
   */
  static async updateStatusExternal(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const { status } = updateStatusSchema.parse(request.body);

    const service = new ServiceRequestService(request.server);
    const result = await service.updateStatus(id, status);

    return ResponseHelper.success(reply, result, 'Status updated');
  }

  /**
   * Cập nhật progress từ hệ thống bên ngoài
   * PUT /public/service-requests/:id/progress
   */
  static async updateProgress(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const body = request.body as {
      totalLinks?: number;
      completedLinks?: number;
      failedLinks?: number;
    };

    const service = new ServiceRequestService(request.server);
    const result = await service.updateProgress(id, body);

    if (!result) {
      return ResponseHelper.notFound(reply, 'ServiceRequest not found');
    }

    return ResponseHelper.success(reply, result, 'Progress updated');
  }
}
