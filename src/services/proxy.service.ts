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
   * Bulk create proxies from text
   */
  async bulkCreateProxies(input: {
    proxies: string;
    type?: ProxyType;
    protocol?: ProxyProtocol;
    services?: ProxyServiceType[];
  }) {
    const lines = input.proxies.split('\n').filter((line) => line.trim());
    const results = {
      created: 0,
      duplicates: 0,
      errors: [] as string[],
    };

    for (const line of lines) {
      const parsed = this.parseProxyString(line);
      if (!parsed) {
        results.errors.push(`Invalid format: ${line}`);
        continue;
      }

      try {
        // Check for duplicate
        const existing = await this.fastify.prisma.proxy.findUnique({
          where: {
            ip_port: {
              ip: parsed.ip,
              port: parsed.port,
            },
          },
        });

        if (existing) {
          results.duplicates++;
          continue;
        }

        // Create proxy
        await this.fastify.prisma.proxy.create({
          data: {
            ip: parsed.ip,
            port: parsed.port,
            username: parsed.username || null,
            password: parsed.password || null,
            type: input.type || ProxyType.IPV4_STATIC,
            protocol: input.protocol || ProxyProtocol.HTTP,
            services: input.services || [],
          },
        });

        results.created++;
      } catch (error) {
        results.errors.push(`Error creating ${parsed.ip}:${parsed.port}`);
      }
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

    // Build where clause
    const where: Prisma.ProxyWhereInput = {};

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

    // Build orderBy
    const orderBy: Prisma.ProxyOrderByWithRelationInput = {};
    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = query.sortOrder || 'desc';
    orderBy[sortBy] = sortOrder;

    // Get proxies and count
    const [proxies, total] = await Promise.all([
      this.fastify.prisma.proxy.findMany({
        skip,
        take: limit,
        where,
        orderBy,
      }),
      this.fastify.prisma.proxy.count({ where }),
    ]);

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
   * Delete proxy
   */
  async deleteProxy(id: string) {
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
   * Bulk delete proxies
   */
  async bulkDeleteProxies(ids: string[]) {
    const result = await this.fastify.prisma.proxy.deleteMany({
      where: { id: { in: ids } },
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
