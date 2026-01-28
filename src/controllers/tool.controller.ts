import { FastifyRequest, FastifyReply } from 'fastify';
import { ToolStatus, ToolType, ToolService } from '@prisma/client';
import { ToolServiceClass } from '../services/tool.service';
import { ResponseHelper } from '../utils/response';
import {
  createToolSchema,
  updateToolSchema,
  toolQuerySchema,
  ToolQueryDTO,
} from '../validators/tool.validator';

export class ToolController {
  /**
   * Get all tools
   * GET /tools/list
   */
  static async findAll(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate query params
    const query: ToolQueryDTO = toolQuerySchema.parse(request.query);

    // Get tools
    const toolService = new ToolServiceClass(request.server);
    const result = await toolService.getAllTools({
      page: query.page,
      limit: query.limit,
      search: query.search,
      type: query.type,
      status: query.status,
      service: query.service,
      userId: query.userId,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });

    return ResponseHelper.success(reply, result);
  }

  /**
   * Get tool by ID
   * GET /tools/detail/:id
   */
  static async findOne(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const toolService = new ToolServiceClass(request.server);
    const tool = await toolService.getToolById(id);

    if (!tool) {
      return ResponseHelper.notFound(reply, 'Tool not found');
    }

    return ResponseHelper.success(reply, tool);
  }

  /**
   * Create new tool
   * POST /tools/create
   */
  static async create(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate request body
    const validatedData = createToolSchema.parse(request.body);

    // Create tool
    const toolService = new ToolServiceClass(request.server);
    const tool = await toolService.createTool(validatedData);

    return ResponseHelper.created(reply, tool, 'Tool created successfully');
  }

  /**
   * Update tool
   * PUT /tools/update/:id
   */
  static async update(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    // Validate request body
    const validatedData = updateToolSchema.parse(request.body);

    // Update tool
    const toolService = new ToolServiceClass(request.server);
    const tool = await toolService.updateTool(id, validatedData);

    return ResponseHelper.success(reply, tool, 'Tool updated successfully');
  }

  /**
   * Delete tool (soft delete)
   * DELETE /tools/delete/:id
   */
  static async delete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const toolService = new ToolServiceClass(request.server);
    await toolService.deleteTool(id);

    return ResponseHelper.success(reply, null, 'Tool deleted successfully');
  }

  /**
   * Restore tool from trash
   * POST /tools/restore/:id
   */
  static async restore(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const toolService = new ToolServiceClass(request.server);
    const tool = await toolService.restoreTool(id);

    return ResponseHelper.success(reply, tool, 'Tool restored successfully');
  }

  /**
   * Permanently delete tool
   * DELETE /tools/permanent/:id
   */
  static async permanentDelete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const toolService = new ToolServiceClass(request.server);
    await toolService.permanentDeleteTool(id);

    return ResponseHelper.success(reply, null, 'Tool permanently deleted');
  }

  /**
   * Mark stale tools as dead (for Monitor Service)
   * POST /tools/mark-stale-dead
   *
   * Uses each tool's estimateTime to determine if it's stale.
   * If estimateTime is null, defaults to 5 minutes and updates the tool.
   */
  static async markStaleDead(request: FastifyRequest, reply: FastifyReply) {
    const toolService = new ToolServiceClass(request.server);
    const result = await toolService.markStaleToolsAsDead();

    let message = 'No stale tools found';
    if (result.markedCount > 0) {
      message = `Marked ${result.markedCount} stale tools as DIE`;
    }
    if (result.estimateTimeUpdated && result.estimateTimeUpdated > 0) {
      message += `. Updated estimateTime for ${result.estimateTimeUpdated} tools`;
    }

    return ResponseHelper.success(reply, result, message);
  }

  /**
   * Tool heartbeat - update tool status and configuration
   * POST /api/public/tools/heartbeat
   */
  static async heartbeat(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as {
      idTool: string;
      status?: string;
      threadNumber?: number;
      type?: string;
      service?: string;
      estimateTime?: number;
    };

    if (!body.idTool) {
      return ResponseHelper.badRequest(reply, 'idTool is required');
    }

    // Build update data
    const updateData: {
      status?: ToolStatus;
      threadNumber?: number;
      type?: ToolType;
      service?: ToolService;
      estimateTime?: number;
    } = {};

    // Validate status if provided
    if (body.status) {
      if (!Object.values(ToolStatus).includes(body.status as ToolStatus)) {
        return ResponseHelper.badRequest(
          reply,
          `Invalid status. Must be one of: ${Object.values(ToolStatus).join(', ')}`
        );
      }
      updateData.status = body.status as ToolStatus;
    }

    // Validate type if provided
    if (body.type) {
      if (!Object.values(ToolType).includes(body.type as ToolType)) {
        return ResponseHelper.badRequest(
          reply,
          `Invalid type. Must be one of: ${Object.values(ToolType).join(', ')}`
        );
      }
      updateData.type = body.type as ToolType;
    }

    // Validate service if provided
    if (body.service) {
      if (!Object.values(ToolService).includes(body.service as ToolService)) {
        return ResponseHelper.badRequest(
          reply,
          `Invalid service. Must be one of: ${Object.values(ToolService).join(', ')}`
        );
      }
      updateData.service = body.service as ToolService;
    }

    // Validate threadNumber if provided
    if (body.threadNumber !== undefined) {
      if (typeof body.threadNumber !== 'number' || body.threadNumber < 1) {
        return ResponseHelper.badRequest(reply, 'threadNumber must be a positive integer');
      }
      updateData.threadNumber = body.threadNumber;
    }

    // Validate estimateTime if provided
    if (body.estimateTime !== undefined) {
      if (typeof body.estimateTime !== 'number' || body.estimateTime < 1) {
        return ResponseHelper.badRequest(reply, 'estimateTime must be a positive integer (minutes)');
      }
      updateData.estimateTime = body.estimateTime;
    }

    const toolService = new ToolServiceClass(request.server);
    const tool = await toolService.toolHeartbeat(body.idTool, updateData);

    return ResponseHelper.success(reply, tool, 'Heartbeat received');
  }
}
