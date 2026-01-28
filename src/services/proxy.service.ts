import { FastifyInstance } from 'fastify';
import { ProxyType, ProxyProtocol, ProxyStatus, ProxyServiceType, Prisma } from '@prisma/client';
import { proxyChecker, CheckProgress } from './proxy-checker.service';

export interface CreateProxyInput {
  ip: string;
  port: number;
  username?: string | null;
  password?: string | null;
  type?: ProxyType;
  protocol?: ProxyProtocol;
  services?: ProxyServiceType[];
  note?: string | null;
}

export interface UpdateProxyInput {
  ip?: string;
  port?: number;
  username?: string | null;
  password?: string | null;
  type?: ProxyType;
  protocol?: ProxyProtocol;
  status?: ProxyStatus;
  services?: ProxyServiceType[];
  note?: string | null;
}

export interface ProxyQueryInput {
  page?: number;
  limit?: number;
  search?: string;
  type?: ProxyType;
  protocol?: ProxyProtocol;
  status?: ProxyStatus;
  service?: ProxyServiceType;
  country?: string;
  sortBy?: 'ip' | 'createdAt' | 'status' | 'type' | 'responseTime' | 'lastCheckedAt';
  sortOrder?: 'asc' | 'desc';
  random?: boolean;
}

interface ParsedProxy {
  ip: string;
  port: number;
  username?: string;
  password?: string;
}

export class ProxyServiceClass {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Parse proxy string in format IP:PORT:USERNAME:PASSWORD
   */
  private parseProxyString(line: string): ParsedProxy | null {
    const parts = line.trim().split(':');
    if (parts.length < 2) return null;

    const ip = parts[0];
    const port = parseInt(parts[1], 10);

    if (!ip || isNaN(port) || port < 1 || port > 65535) return null;

    return {
      ip,
      port,
      username: parts[2] || undefined,
      password: parts[3] || undefined,
    };
  }

  /**
   * Create single proxy
   */
  async createProxy(input: CreateProxyInput) {
    const proxy = await this.fastify.prisma.proxy.create({
      data: {
        ip: input.ip,
        port: input.port,
        username: input.username || null,
        password: input.password || null,
        type: input.type || ProxyType.IPV4_STATIC,
        protocol: input.protocol || ProxyProtocol.HTTP,
        services: input.services || [],
        note: input.note || null,
      },
    });

    return proxy;
  }

  /**
   * Bulk create proxies from text (optimized with batch queries and batch writes)
   */
  async bulkCreateProxies(input: {
    proxies: string;
    type?: ProxyType;
    protocol?: ProxyProtocol;
    services?: ProxyServiceType[];
    handleTrashed?: 'restore' | 'replace'; // How to handle proxies in trash
  }) {
    const lines = input.proxies.split('\n').filter((line) => line.trim());
    const results = {
      created: 0,
      duplicates: 0,
      restored: 0,
      replaced: 0,
      errors: [] as string[],
      trashedProxies: [] as Array<{ ip: string; port: number; id: string }>,
    };

    // Parse all proxies first
    const parsedProxies: Array<{
      ip: string;
      port: number;
      username?: string;
      password?: string;
      line: string;
    }> = [];

    for (const line of lines) {
      const parsed = this.parseProxyString(line);
      if (!parsed) {
        results.errors.push(`Invalid format: ${line}`);
        continue;
      }
      parsedProxies.push({ ...parsed, line });
    }

    if (parsedProxies.length === 0) {
      return results;
    }

    // Build OR conditions for batch query
    const orConditions = parsedProxies.map((p) => ({
      ip: p.ip,
      port: p.port,
    }));

    // Batch query: get all existing active proxies
    const existingActiveProxies = await this.fastify.prisma.proxy.findMany({
      where: {
        OR: orConditions,
        deletedAt: null,
      },
      select: { ip: true, port: true },
    });

    // Create a Set for quick lookup
    const activeSet = new Set(
      existingActiveProxies.map((p) => `${p.ip}:${p.port}`)
    );

    // Batch query: get all existing trashed proxies
    const existingTrashedProxies = await this.fastify.prisma.proxy.findMany({
      where: {
        OR: orConditions,
        deletedAt: { not: null },
      },
      select: { id: true, ip: true, port: true },
    });

    // Create a Map for quick lookup
    const trashedMap = new Map(
      existingTrashedProxies.map((p) => [`${p.ip}:${p.port}`, p])
    );

    // Collect items for batch operations
    const toCreate: Array<{
      ip: string;
      port: number;
      username: string | null;
      password: string | null;
      type: ProxyType;
      protocol: ProxyProtocol;
      services: ProxyServiceType[];
    }> = [];
    const toRestoreIds: string[] = [];
    const toDeleteIds: string[] = [];
    const toReplaceData: Array<{
      ip: string;
      port: number;
      username: string | null;
      password: string | null;
    }> = [];

    // Categorize each proxy
    for (const parsed of parsedProxies) {
      const key = `${parsed.ip}:${parsed.port}`;

      // Check for duplicate (only among non-deleted proxies)
      if (activeSet.has(key)) {
        results.duplicates++;
        continue;
      }

      // Check for soft-deleted proxy with same ip:port
      const existingTrashed = trashedMap.get(key);

      if (existingTrashed) {
        // If no handleTrashed option specified, collect for user decision
        if (!input.handleTrashed) {
          results.trashedProxies.push({
            ip: parsed.ip,
            port: parsed.port,
            id: existingTrashed.id,
          });
          continue;
        }

        // Handle based on user's choice
        if (input.handleTrashed === 'restore') {
          toRestoreIds.push(existingTrashed.id);
          results.restored++;
          continue;
        } else if (input.handleTrashed === 'replace') {
          toDeleteIds.push(existingTrashed.id);
          toReplaceData.push({
            ip: parsed.ip,
            port: parsed.port,
            username: parsed.username || null,
            password: parsed.password || null,
          });
          results.replaced++;
          continue;
        }
      }

      // Collect for batch create
      toCreate.push({
        ip: parsed.ip,
        port: parsed.port,
        username: parsed.username || null,
        password: parsed.password || null,
        type: input.type || ProxyType.IPV4_STATIC,
        protocol: input.protocol || ProxyProtocol.HTTP,
        services: input.services || [],
      });
      results.created++;
    }

    // Execute batch operations
    try {
      // Batch restore: update all trashed proxies at once
      if (toRestoreIds.length > 0) {
        await this.fastify.prisma.proxy.updateMany({
          where: { id: { in: toRestoreIds } },
          data: {
            deletedAt: null,
            type: input.type || ProxyType.IPV4_STATIC,
            protocol: input.protocol || ProxyProtocol.HTTP,
            services: input.services || [],
            status: ProxyStatus.UNKNOWN,
          },
        });
      }

      // Batch replace: delete old ones first
      if (toDeleteIds.length > 0) {
        await this.fastify.prisma.proxy.deleteMany({
          where: { id: { in: toDeleteIds } },
        });

        // Then batch create new ones
        if (toReplaceData.length > 0) {
          await this.fastify.prisma.proxy.createMany({
            data: toReplaceData.map((p) => ({
              ip: p.ip,
              port: p.port,
              username: p.username,
              password: p.password,
              type: input.type || ProxyType.IPV4_STATIC,
              protocol: input.protocol || ProxyProtocol.HTTP,
              services: input.services || [],
            })),
          });
        }
      }

      // Batch create new proxies
      if (toCreate.length > 0) {
        await this.fastify.prisma.proxy.createMany({
          data: toCreate,
        });
      }
    } catch (error) {
      // If batch operation fails, report error
      results.errors.push(`Batch operation failed: ${(error as Error).message}`);
      // Reset counts since operation failed
      results.created = 0;
      results.restored = 0;
      results.replaced = 0;
    }

    return results;
  }

  /**
   * Get all proxies with pagination and filtering
   */
  async getAllProxies(query: ProxyQueryInput) {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    // Build where clause - exclude soft deleted by default
    const where: Prisma.ProxyWhereInput = {
      deletedAt: null,
    };

    if (query.search) {
      where.ip = { contains: query.search, mode: 'insensitive' };
    }

    if (query.type) {
      where.type = query.type;
    }

    if (query.protocol) {
      where.protocol = query.protocol;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.service) {
      where.services = { has: query.service };
    }

    if (query.country) {
      where.country = query.country;
    }

    // Get total count
    const total = await this.fastify.prisma.proxy.count({ where });

    let proxies;

    if (query.random && limit < total) {
      // Random selection: get all IDs matching filter, then randomly pick `limit` items
      const allIds = await this.fastify.prisma.proxy.findMany({
        where,
        select: { id: true },
      });

      // Shuffle and pick random IDs
      const shuffled = allIds.sort(() => Math.random() - 0.5);
      const randomIds = shuffled.slice(0, limit).map((p) => p.id);

      // Fetch full proxy data for random IDs
      proxies = await this.fastify.prisma.proxy.findMany({
        where: { id: { in: randomIds } },
      });
    } else {
      // Normal pagination with sorting
      const orderBy: Prisma.ProxyOrderByWithRelationInput = {};
      const sortBy = query.sortBy || 'createdAt';
      const sortOrder = query.sortOrder || 'desc';
      orderBy[sortBy] = sortOrder;

      proxies = await this.fastify.prisma.proxy.findMany({
        skip,
        take: limit,
        where,
        orderBy,
      });
    }

    return {
      data: proxies,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get proxy by ID
   */
  async getProxyById(id: string) {
    const proxy = await this.fastify.prisma.proxy.findUnique({
      where: { id },
    });

    return proxy;
  }

  /**
   * Update proxy
   */
  async updateProxy(id: string, input: UpdateProxyInput) {
    // Check if proxy exists
    const existingProxy = await this.fastify.prisma.proxy.findUnique({
      where: { id },
    });
    if (!existingProxy) {
      throw this.fastify.httpErrors.notFound('Proxy not found');
    }

    // Update proxy
    const proxy = await this.fastify.prisma.proxy.update({
      where: { id },
      data: input,
    });

    return proxy;
  }

  /**
   * Soft delete proxy
   */
  async deleteProxy(id: string) {
    // Check if proxy exists and not already deleted
    const existingProxy = await this.fastify.prisma.proxy.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existingProxy) {
      throw this.fastify.httpErrors.notFound('Proxy not found');
    }

    await this.fastify.prisma.proxy.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Bulk soft delete proxies
   */
  async bulkDeleteProxies(ids: string[]) {
    const result = await this.fastify.prisma.proxy.updateMany({
      where: { id: { in: ids }, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return { deleted: result.count };
  }

  /**
   * Get deleted proxies (trash)
   */
  async getDeletedProxies(query: ProxyQueryInput) {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    // Build where clause - only soft deleted
    const where: Prisma.ProxyWhereInput = {
      deletedAt: { not: null },
    };

    if (query.search) {
      where.ip = { contains: query.search, mode: 'insensitive' };
    }

    if (query.type) {
      where.type = query.type;
    }

    if (query.status) {
      where.status = query.status;
    }

    // Get total count
    const total = await this.fastify.prisma.proxy.count({ where });

    // Get proxies with sorting
    const orderBy: Prisma.ProxyOrderByWithRelationInput = {};
    const sortBy = query.sortBy || 'deletedAt';
    const sortOrder = query.sortOrder || 'desc';

    if (sortBy === 'deletedAt') {
      orderBy.deletedAt = sortOrder;
    } else {
      orderBy[sortBy] = sortOrder;
    }

    const proxies = await this.fastify.prisma.proxy.findMany({
      skip,
      take: limit,
      where,
      orderBy,
    });

    return {
      data: proxies,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Restore soft deleted proxy
   */
  async restoreProxy(id: string) {
    // Check if proxy exists and is deleted
    const existingProxy = await this.fastify.prisma.proxy.findFirst({
      where: { id, deletedAt: { not: null } },
    });
    if (!existingProxy) {
      throw this.fastify.httpErrors.notFound('Deleted proxy not found');
    }

    const proxy = await this.fastify.prisma.proxy.update({
      where: { id },
      data: { deletedAt: null },
    });

    return proxy;
  }

  /**
   * Bulk restore soft deleted proxies
   */
  async bulkRestoreProxies(ids: string[]) {
    const result = await this.fastify.prisma.proxy.updateMany({
      where: { id: { in: ids }, deletedAt: { not: null } },
      data: { deletedAt: null },
    });

    return { restored: result.count };
  }

  /**
   * Permanently delete proxy
   */
  async permanentDeleteProxy(id: string) {
    // Check if proxy exists
    const existingProxy = await this.fastify.prisma.proxy.findUnique({
      where: { id },
    });
    if (!existingProxy) {
      throw this.fastify.httpErrors.notFound('Proxy not found');
    }

    await this.fastify.prisma.proxy.delete({
      where: { id },
    });
  }

  /**
   * Bulk permanent delete proxies
   */
  async bulkPermanentDeleteProxies(ids: string[]) {
    const result = await this.fastify.prisma.proxy.deleteMany({
      where: { id: { in: ids } },
    });

    return { deleted: result.count };
  }

  /**
   * Empty trash (permanent delete all soft deleted)
   */
  async emptyTrash() {
    const result = await this.fastify.prisma.proxy.deleteMany({
      where: { deletedAt: { not: null } },
    });

    return { deleted: result.count };
  }

  /**
   * Check single proxy
   */
  async checkProxy(id: string) {
    const proxy = await this.fastify.prisma.proxy.findUnique({
      where: { id },
    });
    if (!proxy) {
      throw this.fastify.httpErrors.notFound('Proxy not found');
    }

    // Update status to checking
    await this.fastify.prisma.proxy.update({
      where: { id },
      data: { status: ProxyStatus.CHECKING },
    });

    // Perform proxy check
    const startTime = Date.now();
    let status: ProxyStatus = ProxyStatus.DEAD;
    let responseTime: number | null = null;

    try {
      // Use a simple fetch with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      // TODO: Implement proper proxy check using proxy agent
      // For now, just test basic connectivity
      const response = await fetch('https://httpbin.org/ip', {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        status = ProxyStatus.ACTIVE;
        responseTime = Date.now() - startTime;
      }
    } catch {
      status = ProxyStatus.DEAD;
    }

    // Update proxy with results
    const updatedProxy = await this.fastify.prisma.proxy.update({
      where: { id },
      data: {
        status,
        responseTime,
        lastCheckedAt: new Date(),
        failCount: status === ProxyStatus.DEAD ? proxy.failCount + 1 : 0,
      },
    });

    return updatedProxy;
  }

  /**
   * Check all proxies (background processing with concurrency control)
   */
  async checkAllProxies() {
    // Initialize proxy checker with fastify instance
    proxyChecker.setFastify(this.fastify);

    // Start background check for all proxies (empty array = all)
    const result = await proxyChecker.startCheck([]);

    return {
      total: result.total,
      message: result.message,
    };
  }

  /**
   * Check selected proxies (background processing with concurrency control)
   */
  async checkSelectedProxies(ids: string[]) {
    if (ids.length === 0) {
      return { total: 0, message: 'No proxies selected' };
    }

    // Initialize proxy checker with fastify instance
    proxyChecker.setFastify(this.fastify);

    // Start background check for selected proxies
    const result = await proxyChecker.startCheck(ids);

    return {
      total: result.total,
      message: result.message,
    };
  }

  /**
   * Get check progress
   */
  getCheckProgress(): CheckProgress {
    return proxyChecker.getProgress();
  }

  /**
   * Stop ongoing check
   */
  async stopCheck() {
    await proxyChecker.stopCheck();
    return { message: 'Check stopped' };
  }
}
