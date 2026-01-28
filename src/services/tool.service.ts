import { FastifyInstance } from 'fastify';
import { ToolType, ToolStatus, ToolService, Prisma } from '@prisma/client';

export interface CreateToolInput {
  idTool: string;
  userId?: string | null;
  threadNumber?: number;
  type?: ToolType;
  status?: ToolStatus;
  service?: ToolService;
  estimateTime?: number | null;
  customerType?: string | null;
}

export interface UpdateToolInput {
  idTool?: string;
  userId?: string | null;
  threadNumber?: number;
  type?: ToolType;
  status?: ToolStatus;
  service?: ToolService;
  estimateTime?: number | null;
  customerType?: string | null;
}

export interface ToolQueryInput {
  page?: number;
  limit?: number;
  search?: string;
  type?: ToolType;
  status?: ToolStatus;
  service?: ToolService;
  userId?: string;
  sortBy?: 'idTool' | 'createdAt' | 'status' | 'type' | 'service';
  sortOrder?: 'asc' | 'desc';
}

export class ToolServiceClass {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Create new tool
   */
  async createTool(input: CreateToolInput) {
    // Create tool
    const tool = await this.fastify.prisma.tool.create({
      data: {
        idTool: input.idTool,
        userId: input.userId || null,
        threadNumber: input.threadNumber || 1,
        type: input.type || ToolType.INDIVIDUAL,
        status: input.status || ToolStatus.RUNNING,
        service: input.service || ToolService.ENTITY,
        estimateTime: input.estimateTime || null,
        customerType: input.customerType || null,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return tool;
  }

  /**
   * Get all tools with pagination and filtering
   */
  async getAllTools(query: ToolQueryInput) {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.ToolWhereInput = {
      deletedAt: null,
    };

    if (query.search) {
      where.OR = [
        { idTool: { contains: query.search, mode: 'insensitive' } },
        { customerType: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.type) {
      where.type = query.type;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.service) {
      where.service = query.service;
    }

    if (query.userId) {
      where.userId = query.userId;
    }

    // Build orderBy
    const orderBy: Prisma.ToolOrderByWithRelationInput = {};
    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = query.sortOrder || 'desc';
    orderBy[sortBy] = sortOrder;

    // Get tools and count
    const [tools, total] = await Promise.all([
      this.fastify.prisma.tool.findMany({
        skip,
        take: limit,
        where,
        orderBy,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
        },
      }),
      this.fastify.prisma.tool.count({ where }),
    ]);

    return {
      data: tools,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get tool by ID
   */
  async getToolById(id: string) {
    const tool = await this.fastify.prisma.tool.findFirst({
      where: { id, deletedAt: null },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return tool;
  }

  /**
   * Update tool
   */
  async updateTool(id: string, input: UpdateToolInput) {
    // Check if tool exists
    const existingTool = await this.fastify.prisma.tool.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existingTool) {
      throw this.fastify.httpErrors.notFound('Tool not found');
    }

    // Update tool
    const tool = await this.fastify.prisma.tool.update({
      where: { id },
      data: input,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return tool;
  }

  /**
   * Soft delete tool
   */
  async deleteTool(id: string) {
    // Check if tool exists
    const existingTool = await this.fastify.prisma.tool.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existingTool) {
      throw this.fastify.httpErrors.notFound('Tool not found');
    }

    // Soft delete
    await this.fastify.prisma.tool.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Restore tool from trash
   */
  async restoreTool(id: string) {
    // Check if tool exists in trash
    const existingTool = await this.fastify.prisma.tool.findFirst({
      where: { id, deletedAt: { not: null } },
    });
    if (!existingTool) {
      throw this.fastify.httpErrors.notFound('Tool not found in trash');
    }

    // Restore
    const tool = await this.fastify.prisma.tool.update({
      where: { id },
      data: { deletedAt: null },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return tool;
  }

  /**
   * Permanently delete tool
   */
  async permanentDeleteTool(id: string) {
    // Check if tool exists
    const existingTool = await this.fastify.prisma.tool.findUnique({
      where: { id },
    });
    if (!existingTool) {
      throw this.fastify.httpErrors.notFound('Tool not found');
    }

    await this.fastify.prisma.tool.delete({
      where: { id },
    });
  }

  /**
   * Tool heartbeat - update tool status and other info
   * Used by tools to report their status and update configuration
   */
  async toolHeartbeat(
    idTool: string,
    data: {
      status?: ToolStatus;
      threadNumber?: number;
      type?: ToolType;
      service?: ToolService;
      estimateTime?: number;
    }
  ) {
    // Find tool by idTool
    const existingTool = await this.fastify.prisma.tool.findFirst({
      where: { idTool, deletedAt: null },
    });

    if (!existingTool) {
      throw this.fastify.httpErrors.notFound(`Tool with idTool "${idTool}" not found`);
    }

    // Build update data - only include fields that are provided
    const updateData: Prisma.ToolUpdateInput = {};

    if (data.status !== undefined) {
      updateData.status = data.status;
    } else {
      // Default to RUNNING if not provided
      updateData.status = ToolStatus.RUNNING;
    }

    if (data.threadNumber !== undefined) {
      updateData.threadNumber = data.threadNumber;
    }

    if (data.type !== undefined) {
      updateData.type = data.type;
    }

    if (data.service !== undefined) {
      updateData.service = data.service;
    }

    if (data.estimateTime !== undefined) {
      updateData.estimateTime = data.estimateTime;
    }

    // Update tool
    const tool = await this.fastify.prisma.tool.update({
      where: { id: existingTool.id },
      data: updateData,
      select: {
        id: true,
        idTool: true,
        status: true,
        threadNumber: true,
        type: true,
        service: true,
        estimateTime: true,
        updatedAt: true,
      },
    });

    return tool;
  }

  /**
   * Mark stale tools as dead
   * Tools that haven't been updated for more than their estimateTime will be marked as DIE
   * If estimateTime is null, default to 5 minutes and update the tool's estimateTime
   *
   * OPTIMIZED: Uses raw SQL for better performance with large datasets
   * - Single query to update estimateTime for tools without it
   * - Single query to mark stale tools as DIE and return affected rows
   * - No need to load all tools into memory
   */
  async markStaleToolsAsDead() {
    const DEFAULT_ESTIMATE_TIME = 5; // 5 minutes

    // Step 1: Update estimateTime for tools that don't have it (single UPDATE query)
    const estimateTimeUpdateResult = await this.fastify.prisma.tool.updateMany({
      where: {
        deletedAt: null,
        status: ToolStatus.RUNNING,
        estimateTime: null,
      },
      data: {
        estimateTime: DEFAULT_ESTIMATE_TIME,
      },
    });

    // Step 2: Find and mark stale tools using raw SQL for optimal performance
    // This uses database-level date arithmetic instead of loading all tools into memory
    const staleTools = await this.fastify.prisma.$queryRaw<
      Array<{ id: string; idTool: string; updatedAt: Date; estimateTime: number }>
    >`
      SELECT id, "idTool", "updatedAt", COALESCE("estimateTime", ${DEFAULT_ESTIMATE_TIME}) as "estimateTime"
      FROM "Tool"
      WHERE "deletedAt" IS NULL
        AND status = 'RUNNING'
        AND "updatedAt" < NOW() - (COALESCE("estimateTime", ${DEFAULT_ESTIMATE_TIME}) * INTERVAL '1 minute')
      LIMIT 1000
    `;

    if (staleTools.length === 0) {
      return {
        markedCount: 0,
        tools: [],
        estimateTimeUpdated: estimateTimeUpdateResult.count,
      };
    }

    // Step 3: Update stale tools to DIE status (single UPDATE query with IN clause)
    const staleToolIds = staleTools.map((t) => t.id);

    await this.fastify.prisma.tool.updateMany({
      where: {
        id: { in: staleToolIds },
      },
      data: {
        status: ToolStatus.DIE,
      },
    });

    return {
      markedCount: staleTools.length,
      tools: staleTools.map((t) => ({
        id: t.id,
        idTool: t.idTool,
        lastUpdated: t.updatedAt,
        estimateTime: t.estimateTime,
      })),
      estimateTimeUpdated: estimateTimeUpdateResult.count,
    };
  }
}
