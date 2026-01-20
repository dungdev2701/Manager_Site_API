import { FastifyInstance } from 'fastify';
import { ProxyStatus } from '@prisma/client';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

interface ProxyCheckJob {
  id: string;
  ip: string;
  port: number;
  username: string | null;
  password: string | null;
  protocol: string;
}

export interface CheckProgress {
  isRunning: boolean;
  total: number;
  checked: number;
  active: number;
  dead: number;
  startedAt: Date | null;
}

// Singleton class for managing proxy checking
export class ProxyCheckerService {
  private static instance: ProxyCheckerService;
  private fastify: FastifyInstance | null = null;
  private isRunning = false;
  private queue: ProxyCheckJob[] = [];
  private progress: CheckProgress = {
    isRunning: false,
    total: 0,
    checked: 0,
    active: 0,
    dead: 0,
    startedAt: null,
  };

  // Concurrency settings
  private readonly CONCURRENCY_LIMIT = 20; // Check 20 proxies at a time
  private readonly CHECK_TIMEOUT = 10000; // 10 seconds timeout
  private activeChecks = 0;

  private constructor() {}

  static getInstance(): ProxyCheckerService {
    if (!ProxyCheckerService.instance) {
      ProxyCheckerService.instance = new ProxyCheckerService();
    }
    return ProxyCheckerService.instance;
  }

  setFastify(fastify: FastifyInstance) {
    this.fastify = fastify;
  }

  getProgress(): CheckProgress {
    return { ...this.progress };
  }

  isCheckRunning(): boolean {
    return this.isRunning;
  }

  async startCheck(proxyIds: string[]): Promise<{ total: number; message: string }> {
    if (!this.fastify) {
      throw new Error('Fastify instance not set');
    }

    if (this.isRunning) {
      return {
        total: this.progress.total,
        message: 'Check already in progress',
      };
    }

    // Reset any stuck CHECKING status from previous runs
    // Only reset proxies that will be checked (or all if checking all)
    await this.fastify.prisma.proxy.updateMany({
      where: {
        status: ProxyStatus.CHECKING,
        ...(proxyIds.length > 0 ? { id: { in: proxyIds } } : {}),
      },
      data: { status: ProxyStatus.UNKNOWN },
    });

    // Get proxies to check
    const proxies = await this.fastify.prisma.proxy.findMany({
      where: proxyIds.length > 0 ? { id: { in: proxyIds } } : {},
      select: {
        id: true,
        ip: true,
        port: true,
        username: true,
        password: true,
        protocol: true,
      },
    });

    if (proxies.length === 0) {
      return { total: 0, message: 'No proxies to check' };
    }

    // Mark all as CHECKING
    await this.fastify.prisma.proxy.updateMany({
      where: { id: { in: proxies.map((p) => p.id) } },
      data: { status: ProxyStatus.CHECKING },
    });

    // Initialize progress
    const totalCount = proxies.length; // Store count before queue processing
    this.queue = [...proxies]; // Clone array to avoid mutation
    this.progress = {
      isRunning: true,
      total: proxies.length,
      checked: 0,
      active: 0,
      dead: 0,
      startedAt: new Date(),
    };
    this.isRunning = true;
    this.activeChecks = 0;

    // Start processing in background (non-blocking)
    this.processQueue();

    return {
      total: totalCount,
      message: `Started checking ${totalCount} proxies`,
    };
  }

  async stopCheck(): Promise<void> {
    this.isRunning = false;
    this.queue = [];

    if (this.fastify) {
      // Reset any remaining CHECKING status to UNKNOWN
      await this.fastify.prisma.proxy.updateMany({
        where: { status: ProxyStatus.CHECKING },
        data: { status: ProxyStatus.UNKNOWN },
      });
    }

    this.progress.isRunning = false;
  }

  private async processQueue(): Promise<void> {
    while (this.isRunning && (this.queue.length > 0 || this.activeChecks > 0)) {
      // Start new checks up to concurrency limit
      while (this.activeChecks < this.CONCURRENCY_LIMIT && this.queue.length > 0) {
        const proxy = this.queue.shift();
        if (proxy) {
          this.activeChecks++;
          this.checkSingleProxy(proxy).finally(() => {
            this.activeChecks--;
          });
        }
      }

      // Small delay to prevent CPU hogging
      await this.sleep(100);
    }

    // Cleanup
    this.isRunning = false;
    this.progress.isRunning = false;
  }

  private async checkSingleProxy(proxy: ProxyCheckJob): Promise<void> {
    if (!this.fastify) return;

    let status: ProxyStatus = ProxyStatus.DEAD;
    let responseTime: number | null = null;
    let country: string | null = null;

    try {
      const proxyUrl = this.buildProxyUrl(proxy);
      const result = await this.testProxyConnection(proxyUrl, proxy.protocol);

      if (result.success) {
        status = ProxyStatus.ACTIVE;
        responseTime = result.responseTime;
        country = result.country;
        this.progress.active++;
      } else {
        this.progress.dead++;
      }
    } catch {
      status = ProxyStatus.DEAD;
      this.progress.dead++;
    }

    // Update proxy in database
    try {
      const existingProxy = await this.fastify.prisma.proxy.findUnique({
        where: { id: proxy.id },
        select: { failCount: true },
      });

      await this.fastify.prisma.proxy.update({
        where: { id: proxy.id },
        data: {
          status,
          responseTime,
          lastCheckedAt: new Date(),
          failCount: status === ProxyStatus.DEAD ? (existingProxy?.failCount || 0) + 1 : 0,
          ...(country && { country }), // Only update country if detected
        },
      });
    } catch (error) {
      // Log error but don't stop processing
      console.error(`Failed to update proxy ${proxy.id}:`, error);
    }

    this.progress.checked++;
  }

  private buildProxyUrl(proxy: ProxyCheckJob): string {
    const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
    return `http://${auth}${proxy.ip}:${proxy.port}`;
  }

  private async testProxyConnection(
    proxyUrl: string,
    _protocol: string
  ): Promise<{ success: boolean; responseTime: number | null; country: string | null }> {
    const startTime = Date.now();

    try {
      // Create proxy agent using undici
      const proxyAgent = new ProxyAgent(proxyUrl);

      // Test connection to a reliable endpoint using undici fetch
      const response = await undiciFetch('http://httpbin.org/ip', {
        method: 'GET',
        dispatcher: proxyAgent,
        signal: AbortSignal.timeout(this.CHECK_TIMEOUT),
      });

      // Close the agent after use
      await proxyAgent.close();

      if (response.ok) {
        // Verify that the response contains IP data (proxy actually worked)
        const data = (await response.json()) as { origin?: string };
        if (data.origin) {
          const responseTime = Date.now() - startTime;
          // Get country from proxy IP
          const proxyIp = data.origin.split(',')[0].trim(); // Handle multiple IPs
          const country = await this.getCountryFromIp(proxyIp);

          return {
            success: true,
            responseTime,
            country,
          };
        }
      }

      return { success: false, responseTime: null, country: null };
    } catch (error) {
      // Log for debugging
      console.error(`Proxy check failed for ${proxyUrl}:`, error instanceof Error ? error.message : 'Unknown error');
      return { success: false, responseTime: null, country: null };
    }
  }

  private async getCountryFromIp(ip: string): Promise<string | null> {
    try {
      // Use ip-api.com (free, no API key required, 45 requests/minute)
      const response = await undiciFetch(`http://ip-api.com/json/${ip}?fields=countryCode`, {
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const data = (await response.json()) as { countryCode?: string };
        return data.countryCode || null;
      }

      return null;
    } catch {
      // Silently fail - country detection is not critical
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const proxyChecker = ProxyCheckerService.getInstance();
