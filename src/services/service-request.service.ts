import { FastifyInstance } from 'fastify';
import { Prisma, ServiceType, RequestStatus, DomainSelection } from '@prisma/client';
import { InputJsonValue } from '@prisma/client/runtime/library';

export interface CreateServiceRequestInput {
  externalUserId: string;
  externalUserEmail?: string | null;
  externalUserName?: string | null;
  assignedUserId?: string | null;
  serviceType: ServiceType;
  serviceGroupId?: string | null;
  externalId?: string | null;
  name?: string | null;
  typeRequest?: string | null;
  target?: string | null;
  auctionPrice?: number | null;
  domains?: DomainSelection;
  config?: Record<string, unknown> | null;
}

export interface UpdateServiceRequestInput {
  name?: string | null;
  typeRequest?: string | null;
  target?: string | null;
  auctionPrice?: number | null;
  domains?: DomainSelection;
  config?: Record<string, unknown> | null;
  serviceGroupId?: string | null;
}

export interface ServiceRequestQueryInput {
  page: number;
  limit: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  serviceType?: ServiceType;
  status?: RequestStatus;
  externalUserId?: string;
  domains?: DomainSelection;
}

export interface FlexibleFindByIdInput {
  fields?: string;
  include?: string;
  itemStatus?: string;
  itemLimit?: number;
}

export class ServiceRequestService {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Tạo service request mới
   */
  async create(input: CreateServiceRequestInput) {
    // Nếu có externalId, kiểm tra trùng lặp
    if (input.externalId) {
      const existing = await this.fastify.prisma.serviceRequest.findFirst({
        where: {
          externalId: input.externalId,
          serviceType: input.serviceType,
          deletedAt: null,
        },
      });
      if (existing) {
        throw this.fastify.httpErrors.conflict(
          `ServiceRequest with externalId '${input.externalId}' for ${input.serviceType} already exists`
        );
      }
    }

    return this.fastify.prisma.serviceRequest.create({
      data: {
        externalUserId: input.externalUserId,
        externalUserEmail: input.externalUserEmail ?? null,
        externalUserName: input.externalUserName ?? null,
        assignedUserId: input.assignedUserId ?? null,
        serviceType: input.serviceType,
        serviceGroupId: input.serviceGroupId ?? null,
        externalId: input.externalId ?? null,
        name: input.name ?? null,
        typeRequest: input.typeRequest ?? null,
        target: input.target ?? null,
        auctionPrice: input.auctionPrice ?? null,
        domains: input.domains ?? 'LIKEPION',
        config: (input.config as InputJsonValue) ?? Prisma.JsonNull,
        status: 'DRAFT',
      },
    });
  }

  /**
   * Lấy service request theo ID
   */
  async findById(id: string) {
    const request = await this.fastify.prisma.serviceRequest.findFirst({
      where: { id, deletedAt: null },
      include: {
        assignedUser: { select: { id: true, email: true, name: true } },
        batches: {
          select: {
            id: true,
            batchNumber: true,
            targetCount: true,
            allocatedCount: true,
            status: true,
            createdAt: true,
          },
          orderBy: { batchNumber: 'asc' },
        },
      },
    });

    if (!request) {
      throw this.fastify.httpErrors.notFound('ServiceRequest not found');
    }

    return request;
  }

  /**
   * Lấy service request theo ID với field selection linh hoạt
   *
   * @param id - Request ID
   * @param options - Options for field selection
   *   - fields: Comma-separated field names or 'all' (default: 'all')
   *   - include: Comma-separated relation names (assignedUser, batches, allocationItems)
   *   - itemStatus: Filter allocation items by status (comma-separated)
   *   - itemLimit: Limit number of allocation items returned
   */
  async findByIdFlexible(id: string, options: FlexibleFindByIdInput = {}) {
    const { fields = 'all', include, itemStatus, itemLimit } = options;

    // Build select object for fields
    const allFields = [
      'id', 'externalUserId', 'externalUserEmail', 'externalUserName',
      'assignedUserId', 'serviceType', 'serviceGroupId', 'externalId',
      'name', 'typeRequest', 'target', 'auctionPrice', 'domains',
      'config', 'idTool', 'runCount', 'status', 'createdAt', 'updatedAt',
    ];

    let selectFields: Record<string, boolean> | undefined;
    if (fields !== 'all') {
      const requestedFields = fields.split(',').map(f => f.trim()).filter(f => allFields.includes(f));
      if (requestedFields.length > 0) {
        selectFields = {};
        // Always include id
        selectFields.id = true;
        for (const field of requestedFields) {
          selectFields[field] = true;
        }
      }
    }

    // Build include object for relations
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const includeObj: Record<string, any> = {};
    if (include) {
      const requestedIncludes = include.split(',').map(i => i.trim());

      if (requestedIncludes.includes('assignedUser')) {
        includeObj.assignedUser = { select: { id: true, email: true, name: true } };
      }

      if (requestedIncludes.includes('batches')) {
        includeObj.batches = {
          select: {
            id: true,
            batchNumber: true,
            targetCount: true,
            allocatedCount: true,
            status: true,
            createdAt: true,
          },
          orderBy: { batchNumber: 'asc' },
        };
      }

      if (requestedIncludes.includes('allocationItems')) {
        // Build where clause for items
        const itemWhere: Prisma.AllocationItemWhereInput = {};
        if (itemStatus) {
          const statuses = itemStatus.split(',').map(s => s.trim());
          itemWhere.status = { in: statuses as Prisma.EnumAllocationItemStatusFilter['in'] };
        }

        includeObj.allocationItems = {
          where: Object.keys(itemWhere).length > 0 ? itemWhere : undefined,
          select: {
            id: true,
            domain: true,
            serviceType: true,
            status: true,
            linkProfile: true,
            linkPost: true,
            linkData: true,
            claimedBy: true,
            claimedAt: true,
            retryIndex: true,
            note: true,
            allocatedAt: true,
            completedAt: true,
          },
          orderBy: { allocatedAt: 'desc' },
          take: itemLimit,
        };
      }
    }

    // Build query
    const query: Prisma.ServiceRequestFindFirstArgs = {
      where: { id, deletedAt: null },
    };

    // Use select if specific fields requested, otherwise include relations
    if (selectFields) {
      // When using select, we need to include relations in select
      query.select = {
        ...selectFields,
        ...(Object.keys(includeObj).length > 0 && includeObj),
      };
    } else if (Object.keys(includeObj).length > 0) {
      query.include = includeObj;
    }

    const request = await this.fastify.prisma.serviceRequest.findFirst(query);

    if (!request) {
      throw this.fastify.httpErrors.notFound('ServiceRequest not found');
    }

    return request;
  }

  /**
   * Lấy danh sách service requests với filter và phân trang
   */
  async findAll(query: ServiceRequestQueryInput) {
    const { page, limit, search, sortBy, sortOrder, serviceType, status, externalUserId, domains } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.ServiceRequestWhereInput = {
      deletedAt: null,
      ...(serviceType && { serviceType }),
      ...(status && { status }),
      ...(externalUserId && { externalUserId }),
      ...(domains && { domains }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { externalId: { contains: search, mode: 'insensitive' } },
          { idTool: { contains: search, mode: 'insensitive' } },
          { externalUserEmail: { contains: search, mode: 'insensitive' } },
          { externalUserName: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    // Allowed sort fields
    const allowedSortFields = ['createdAt', 'updatedAt', 'status', 'serviceType', 'name', 'auctionPrice'];
    const orderField = sortBy && allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const orderDir = sortOrder || 'desc';

    const [data, total] = await Promise.all([
      this.fastify.prisma.serviceRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [orderField]: orderDir },
        include: {
          assignedUser: { select: { id: true, email: true, name: true } },
        },
      }),
      this.fastify.prisma.serviceRequest.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Update service request (chỉ khi status = DRAFT hoặc NEW)
   */
  async update(id: string, input: UpdateServiceRequestInput) {
    const existing = await this.fastify.prisma.serviceRequest.findFirst({
      where: { id, deletedAt: null },
    });

    if (!existing) {
      throw this.fastify.httpErrors.notFound('ServiceRequest not found');
    }

    if (!['DRAFT', 'NEW'].includes(existing.status)) {
      throw this.fastify.httpErrors.badRequest(
        `Cannot update request with status '${existing.status}'. Only DRAFT or NEW requests can be updated.`
      );
    }

    return this.fastify.prisma.serviceRequest.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.typeRequest !== undefined && { typeRequest: input.typeRequest }),
        ...(input.target !== undefined && { target: input.target }),
        ...(input.auctionPrice !== undefined && { auctionPrice: input.auctionPrice }),
        ...(input.domains !== undefined && { domains: input.domains }),
        ...(input.serviceGroupId !== undefined && { serviceGroupId: input.serviceGroupId }),
        ...(input.config !== undefined && { config: (input.config as InputJsonValue) ?? Prisma.JsonNull }),
      },
    });
  }

  /**
   * Cập nhật status
   */
  async updateStatus(id: string, status: RequestStatus) {
    const existing = await this.fastify.prisma.serviceRequest.findFirst({
      where: { id, deletedAt: null },
    });

    if (!existing) {
      throw this.fastify.httpErrors.notFound('ServiceRequest not found');
    }

    // Validate status transition
    const validTransitions: Record<string, RequestStatus[]> = {
      DRAFT: ['NEW', 'CANCEL'],
      NEW: ['PENDING', 'CANCEL'],
      PENDING: ['RUNNING', 'CANCEL'],
      RUNNING: ['CONNECTING', 'COMPLETED', 'CANCEL'],
      CONNECTING: ['COMPLETED', 'CANCEL'],
      COMPLETED: [], // Terminal state
      CANCEL: [],    // Terminal state
    };

    const allowed = validTransitions[existing.status] || [];
    if (!allowed.includes(status)) {
      throw this.fastify.httpErrors.badRequest(
        `Cannot transition from '${existing.status}' to '${status}'. Allowed: ${allowed.join(', ') || 'none'}`
      );
    }

    return this.fastify.prisma.serviceRequest.update({
      where: { id },
      data: { status },
    });
  }

  /**
   * Soft delete
   */
  async delete(id: string) {
    const existing = await this.fastify.prisma.serviceRequest.findFirst({
      where: { id, deletedAt: null },
    });

    if (!existing) {
      throw this.fastify.httpErrors.notFound('ServiceRequest not found');
    }

    // Chỉ cho phép xóa khi DRAFT, NEW hoặc CANCEL
    if (!['DRAFT', 'NEW', 'CANCEL', 'COMPLETED'].includes(existing.status)) {
      throw this.fastify.httpErrors.badRequest(
        `Cannot delete request with status '${existing.status}'. Only DRAFT, NEW, CANCEL or COMPLETED requests can be deleted.`
      );
    }

    return this.fastify.prisma.serviceRequest.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Lấy danh sách requests theo status (dùng cho allocation/monitor)
   */
  async findByStatus(status: RequestStatus, serviceType?: ServiceType) {
    return this.fastify.prisma.serviceRequest.findMany({
      where: {
        status,
        deletedAt: null,
        ...(serviceType && { serviceType }),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Lấy request theo externalId + serviceType (dùng cho sync từ KH)
   */
  async findByExternalId(externalId: string, serviceType: ServiceType) {
    return this.fastify.prisma.serviceRequest.findFirst({
      where: {
        externalId,
        serviceType,
        deletedAt: null,
      },
    });
  }

  /**
   * Cập nhật progress tracking
   */
  async updateProgress(
    id: string,
    data: { totalLinks?: number; completedLinks?: number; failedLinks?: number }
  ) {
    const request = await this.fastify.prisma.serviceRequest.findUnique({
      where: { id },
    });
    if (!request) return null;

    const totalLinks = data.totalLinks ?? request.totalLinks;
    const completedLinks = data.completedLinks ?? request.completedLinks;
    const failedLinks = data.failedLinks ?? request.failedLinks;
    const progressPercent = totalLinks > 0
      ? Math.min(100, ((completedLinks + failedLinks) / totalLinks) * 100)
      : 0;

    return this.fastify.prisma.serviceRequest.update({
      where: { id },
      data: {
        totalLinks,
        completedLinks,
        failedLinks,
        progressPercent,
      },
    });
  }

  /**
   * Quick update cho admin/dev - không giới hạn status
   */
  async quickUpdate(id: string, data: { idTool?: string | null; runCount?: number; target?: string | null; status?: RequestStatus }) {
    const existing = await this.fastify.prisma.serviceRequest.findFirst({
      where: { id, deletedAt: null },
    });

    if (!existing) {
      throw this.fastify.httpErrors.notFound('ServiceRequest not found');
    }

    return this.fastify.prisma.serviceRequest.update({
      where: { id },
      data: {
        ...(data.idTool !== undefined && { idTool: data.idTool }),
        ...(data.runCount !== undefined && { runCount: data.runCount }),
        ...(data.target !== undefined && { target: data.target }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });
  }

  /**
   * Assign tool pair cho request
   */
  async assignTool(id: string, idTool: string) {
    return this.fastify.prisma.serviceRequest.update({
      where: { id },
      data: { idTool },
    });
  }
}
