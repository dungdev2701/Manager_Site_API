import { FastifyRequest, FastifyReply } from 'fastify';
import { ProxyServiceClass } from '../services/proxy.service';
import { ResponseHelper } from '../utils/response';
import {
  createProxySchema,
  bulkCreateProxySchema,
  updateProxySchema,
  proxyQuerySchema,
  bulkDeleteProxySchema,
  ProxyQueryDTO,
} from '../validators/proxy.validator';

export class ProxyController {
  /**
   * Get all proxies
   * GET /proxies/list
   * Supports authentication via JWT token or API key
   */
  static async findAll(request: FastifyRequest, reply: FastifyReply) {
    // Note: Authentication is handled by authOrApiKeyMiddleware
    // request.user may be undefined when using API key authentication

    // Validate query params
    const query: ProxyQueryDTO = proxyQuerySchema.parse(request.query);

    // Get proxies
    const proxyService = new ProxyServiceClass(request.server);
    const result = await proxyService.getAllProxies({
      page: query.page,
      limit: query.limit,
      search: query.search,
      type: query.type,
      protocol: query.protocol,
      status: query.status,
      service: query.service,
      country: query.country,
      sortBy: query.sortBy as 'ip' | 'createdAt' | 'status' | 'type' | 'responseTime' | 'lastCheckedAt' | undefined,
      sortOrder: query.sortOrder as 'asc' | 'desc' | undefined,
      random: query.random,
    });

    return ResponseHelper.success(reply, result);
  }

  /**
   * Get proxy by ID
   * GET /proxies/detail/:id
   */
  static async findOne(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const proxyService = new ProxyServiceClass(request.server);
    const proxy = await proxyService.getProxyById(id);

    if (!proxy) {
      return ResponseHelper.notFound(reply, 'Proxy not found');
    }

    return ResponseHelper.success(reply, proxy);
  }

  /**
   * Create new proxy
   * POST /proxies/create
   */
  static async create(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate request body
    const validatedData = createProxySchema.parse(request.body);

    // Create proxy
    const proxyService = new ProxyServiceClass(request.server);
    const proxy = await proxyService.createProxy(validatedData);

    return ResponseHelper.created(reply, proxy, 'Proxy created successfully');
  }

  /**
   * Bulk create proxies
   * POST /proxies/bulk-create
   */
  static async bulkCreate(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate request body
    const validatedData = bulkCreateProxySchema.parse(request.body);

    // Bulk create proxies
    const proxyService = new ProxyServiceClass(request.server);
    const result = await proxyService.bulkCreateProxies(validatedData);

    return ResponseHelper.created(reply, result, 'Proxies created successfully');
  }

  /**
   * Update proxy
   * PUT /proxies/update/:id
   */
  static async update(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    // Validate request body
    const validatedData = updateProxySchema.parse(request.body);

    // Update proxy
    const proxyService = new ProxyServiceClass(request.server);
    const proxy = await proxyService.updateProxy(id, validatedData);

    return ResponseHelper.success(reply, proxy, 'Proxy updated successfully');
  }

  /**
   * Delete proxy
   * DELETE /proxies/delete/:id
   */
  static async delete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const proxyService = new ProxyServiceClass(request.server);
    await proxyService.deleteProxy(id);

    return ResponseHelper.success(reply, null, 'Proxy deleted successfully');
  }

  /**
   * Bulk delete proxies
   * POST /proxies/bulk-delete
   */
  static async bulkDelete(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate request body
    const validatedData = bulkDeleteProxySchema.parse(request.body);

    const proxyService = new ProxyServiceClass(request.server);
    const result = await proxyService.bulkDeleteProxies(validatedData.ids);

    return ResponseHelper.success(reply, result, 'Proxies deleted successfully');
  }

  /**
   * Check single proxy
   * POST /proxies/check/:id
   */
  static async checkProxy(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };

    const proxyService = new ProxyServiceClass(request.server);
    const proxy = await proxyService.checkProxy(id);

    return ResponseHelper.success(reply, proxy, 'Proxy checked successfully');
  }

  /**
   * Check all proxies
   * POST /proxies/check-all
   */
  static async checkAllProxies(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const proxyService = new ProxyServiceClass(request.server);
    const result = await proxyService.checkAllProxies();

    return ResponseHelper.success(reply, result, 'Proxy check started');
  }

  /**
   * Check selected proxies
   * POST /proxies/check-selected
   */
  static async checkSelectedProxies(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    // Validate request body
    const validatedData = bulkDeleteProxySchema.parse(request.body);

    const proxyService = new ProxyServiceClass(request.server);
    const result = await proxyService.checkSelectedProxies(validatedData.ids);

    return ResponseHelper.success(reply, result, 'Proxy check started');
  }

  /**
   * Get check progress
   * GET /proxies/check-status
   */
  static async getCheckStatus(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const proxyService = new ProxyServiceClass(request.server);
    const progress = proxyService.getCheckProgress();

    return ResponseHelper.success(reply, progress);
  }

  /**
   * Stop ongoing check
   * POST /proxies/check-stop
   */
  static async stopCheck(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const proxyService = new ProxyServiceClass(request.server);
    const result = await proxyService.stopCheck();

    return ResponseHelper.success(reply, result, 'Check stopped');
  }
}
