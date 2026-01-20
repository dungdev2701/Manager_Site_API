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
}
