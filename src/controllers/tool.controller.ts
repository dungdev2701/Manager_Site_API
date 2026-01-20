import { FastifyRequest, FastifyReply } from 'fastify';
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
}
