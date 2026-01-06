import { PrismaClient } from '@prisma/client';

export interface DailyPerformance {
  date: Date;
  allocationCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
}

export interface EditorInfo {
  date: Date;
  userId: string;
  userName: string | null;
  userEmail: string;
  changes: Record<string, unknown>;
}

export class PerformanceRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get daily performance data for a website within a date range
   */
  async getDailyPerformance(
    websiteId: string,
    startDate: Date,
    endDate: Date
  ): Promise<DailyPerformance[]> {
    const dailyAllocations = await this.prisma.dailyAllocation.findMany({
      where: {
        websiteId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: {
        date: 'asc',
      },
    });

    return dailyAllocations.map((da) => ({
      date: da.date,
      allocationCount: da.allocationCount,
      successCount: da.successCount,
      failureCount: da.failureCount,
      successRate:
        da.allocationCount > 0
          ? Math.round((da.successCount / da.allocationCount) * 100 * 100) / 100
          : 0,
    }));
  }

  /**
   * Get edit events from audit logs for a website within a date range
   */
  async getEditEvents(
    websiteId: string,
    startDate: Date,
    endDate: Date
  ): Promise<EditorInfo[]> {
    const auditLogs = await this.prisma.auditLog.findMany({
      where: {
        entity: 'Website',
        entityId: websiteId,
        action: 'UPDATE',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Get user info
    const userIds = [...new Set(auditLogs.map((log) => log.userId).filter(Boolean))] as string[];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return auditLogs.map((log) => {
      const user = log.userId ? userMap.get(log.userId) : null;
      return {
        date: log.createdAt,
        userId: log.userId || '',
        userName: user?.name || null,
        userEmail: user?.email || 'Unknown',
        changes: (log.newValues as Record<string, unknown>) || {},
      };
    });
  }

  /**
   * Get website basic info
   */
  async getWebsiteInfo(websiteId: string) {
    return this.prisma.website.findUnique({
      where: { id: websiteId },
      select: {
        id: true,
        domain: true,
        status: true,
        type: true,
        metrics: true,
        createdAt: true,
      },
    });
  }

  /**
   * Get overall stats for a website
   */
  async getOverallStats(websiteId: string, startDate: Date, endDate: Date) {
    const result = await this.prisma.dailyAllocation.aggregate({
      where: {
        websiteId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      _sum: {
        allocationCount: true,
        successCount: true,
        failureCount: true,
      },
    });

    const totalAllocations = result._sum.allocationCount || 0;
    const totalSuccess = result._sum.successCount || 0;
    const totalFailure = result._sum.failureCount || 0;

    return {
      totalAllocations,
      totalSuccess,
      totalFailure,
      overallSuccessRate:
        totalAllocations > 0
          ? Math.round((totalSuccess / totalAllocations) * 100 * 100) / 100
          : 0,
    };
  }

  /**
   * Get number of unique editors in a period
   */
  async getEditorCount(websiteId: string, startDate: Date, endDate: Date): Promise<number> {
    const result = await this.prisma.auditLog.findMany({
      where: {
        entity: 'Website',
        entityId: websiteId,
        action: 'UPDATE',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        userId: true,
      },
      distinct: ['userId'],
    });

    return result.filter((r) => r.userId).length;
  }
}
