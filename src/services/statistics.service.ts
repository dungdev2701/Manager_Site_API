import { FastifyInstance } from 'fastify';

export class StatisticsService {
  constructor(private fastify: FastifyInstance) {}

  async getOverview() {
    const prisma = this.fastify.prisma;

    // Get total websites count
    const totalWebsites = await prisma.website.count({
      where: { deletedAt: null },
    });

    // Get status counts
    const statusCounts = await prisma.website.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { status: true },
    });

    // Get type counts
    const typeCounts = await prisma.website.groupBy({
      by: ['type'],
      where: { deletedAt: null },
      _count: { type: true },
    });

    // Get total users
    const totalUsers = await prisma.user.count({
      where: { isActive: true },
    });

    // Get allocation stats for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const allocationStats = await prisma.dailyAllocation.aggregate({
      where: {
        date: { gte: thirtyDaysAgo },
      },
      _sum: {
        allocationCount: true,
        successCount: true,
        failureCount: true,
      },
    });

    const totalAllocations = allocationStats._sum.allocationCount || 0;
    const totalSuccess = allocationStats._sum.successCount || 0;
    const totalFailure = allocationStats._sum.failureCount || 0;
    const overallSuccessRate =
      totalAllocations > 0
        ? Math.round((totalSuccess / totalAllocations) * 100 * 100) / 100
        : 0;

    // Get websites added this week
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const websitesThisWeek = await prisma.website.count({
      where: {
        deletedAt: null,
        createdAt: { gte: oneWeekAgo },
      },
    });

    // Calculate running percentage
    const runningCount =
      statusCounts.find((s) => s.status === 'RUNNING')?._count.status || 0;
    const runningPercentage =
      totalWebsites > 0
        ? Math.round((runningCount / totalWebsites) * 100 * 100) / 100
        : 0;

    return {
      totalWebsites,
      totalUsers,
      websitesThisWeek,
      runningPercentage,
      statusCounts: statusCounts.map((s) => ({
        status: s.status,
        count: s._count.status,
      })),
      typeCounts: typeCounts.map((t) => ({
        type: t.type,
        count: t._count.type,
      })),
      allocationStats: {
        totalAllocations,
        totalSuccess,
        totalFailure,
        overallSuccessRate,
        period: '30 days',
      },
    };
  }

  async getByStatus() {
    const prisma = this.fastify.prisma;

    const stats = await prisma.website.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { status: true },
    });

    const total = stats.reduce((sum, s) => sum + s._count.status, 0);

    return stats.map((s) => ({
      status: s.status,
      count: s._count.status,
      percentage: total > 0 ? Math.round((s._count.status / total) * 100 * 100) / 100 : 0,
    }));
  }

  async getByType() {
    const prisma = this.fastify.prisma;

    const stats = await prisma.website.groupBy({
      by: ['type'],
      where: { deletedAt: null },
      _count: { type: true },
    });

    const total = stats.reduce((sum, s) => sum + s._count.type, 0);

    return stats.map((s) => ({
      type: s.type,
      count: s._count.type,
      percentage: total > 0 ? Math.round((s._count.type / total) * 100 * 100) / 100 : 0,
    }));
  }

  async getAllocationStats(startDate: Date, endDate: Date) {
    const prisma = this.fastify.prisma;

    const dailyStats = await prisma.dailyAllocation.groupBy({
      by: ['date'],
      where: {
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
      orderBy: {
        date: 'asc',
      },
    });

    // Fill in missing dates with zeros
    const result: {
      date: string;
      allocations: number;
      success: number;
      failure: number;
      successRate: number;
    }[] = [];

    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];
      const dayStats = dailyStats.find(
        (d) => d.date.toISOString().split('T')[0] === dateKey
      );

      const allocations = dayStats?._sum.allocationCount || 0;
      const success = dayStats?._sum.successCount || 0;
      const failure = dayStats?._sum.failureCount || 0;
      const successRate =
        allocations > 0 ? Math.round((success / allocations) * 100 * 100) / 100 : 0;

      result.push({
        date: dateKey,
        allocations,
        success,
        failure,
        successRate,
      });

      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Calculate totals
    const totalAllocations = result.reduce((sum, d) => sum + d.allocations, 0);
    const totalSuccess = result.reduce((sum, d) => sum + d.success, 0);
    const totalFailure = result.reduce((sum, d) => sum + d.failure, 0);
    const overallSuccessRate =
      totalAllocations > 0
        ? Math.round((totalSuccess / totalAllocations) * 100 * 100) / 100
        : 0;

    return {
      daily: result,
      summary: {
        totalAllocations,
        totalSuccess,
        totalFailure,
        overallSuccessRate,
        avgDailyAllocations: Math.round(totalAllocations / result.length),
      },
    };
  }

  async getTopWebsites(
    startDate: Date,
    endDate: Date,
    limit: number = 10,
    sortBy: 'successRate' | 'allocations' | 'success' | 'failure' = 'successRate',
    order: 'asc' | 'desc' = 'desc'
  ) {
    const prisma = this.fastify.prisma;

    // Get aggregated stats per website
    const websiteStats = await prisma.dailyAllocation.groupBy({
      by: ['websiteId'],
      where: {
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

    // Get website details
    const websiteIds = websiteStats.map((w) => w.websiteId);
    const websites = await prisma.website.findMany({
      where: {
        id: { in: websiteIds },
        deletedAt: null,
      },
      select: {
        id: true,
        domain: true,
        status: true,
        type: true,
      },
    });

    const websiteMap = new Map(websites.map((w) => [w.id, w]));

    // Calculate stats and sort
    const result = websiteStats
      .map((ws) => {
        const website = websiteMap.get(ws.websiteId);
        if (!website) return null;

        const allocations = ws._sum.allocationCount || 0;
        const success = ws._sum.successCount || 0;
        const failure = ws._sum.failureCount || 0;
        const successRate =
          allocations > 0 ? Math.round((success / allocations) * 100 * 100) / 100 : 0;

        return {
          websiteId: ws.websiteId,
          domain: website.domain,
          status: website.status,
          type: website.type,
          allocations,
          success,
          failure,
          successRate,
        };
      })
      .filter((w) => w !== null)
      .sort((a, b) => {
        const aVal = a[sortBy] as number;
        const bVal = b[sortBy] as number;
        return order === 'desc' ? bVal - aVal : aVal - bVal;
      })
      .slice(0, limit);

    return result;
  }

  async getEditorStats(startDate: Date, endDate: Date) {
    const prisma = this.fastify.prisma;

    // Get all edits in the period
    const edits = await prisma.auditLog.findMany({
      where: {
        entity: 'Website',
        action: 'UPDATE',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        userId: { not: null },
      },
      select: {
        userId: true,
        createdAt: true,
      },
    });

    // Group by user
    const userEdits = new Map<string, number>();
    for (const edit of edits) {
      if (edit.userId) {
        userEdits.set(edit.userId, (userEdits.get(edit.userId) || 0) + 1);
      }
    }

    // Get user details
    const userIds = Array.from(userEdits.keys());
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    // Build result
    const result = Array.from(userEdits.entries())
      .map(([userId, editCount]) => {
        const user = userMap.get(userId);
        if (!user) return null;

        return {
          userId,
          name: user.name,
          email: user.email,
          role: user.role,
          editCount,
        };
      })
      .filter((e) => e !== null)
      .sort((a, b) => b.editCount - a.editCount);

    return result;
  }

  async getDailyTrends(startDate: Date, endDate: Date) {
    const prisma = this.fastify.prisma;

    // Get websites created per day
    const websitesCreated = await prisma.website.groupBy({
      by: ['createdAt'],
      where: {
        deletedAt: null,
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      _count: { id: true },
    });

    // Get edits per day
    const editsPerDay = await prisma.auditLog.groupBy({
      by: ['createdAt'],
      where: {
        entity: 'Website',
        action: 'UPDATE',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      _count: { id: true },
    });

    // Build daily data
    const result: {
      date: string;
      websitesCreated: number;
      edits: number;
    }[] = [];

    const websitesByDate = new Map<string, number>();
    for (const w of websitesCreated) {
      const dateKey = w.createdAt.toISOString().split('T')[0];
      websitesByDate.set(dateKey, (websitesByDate.get(dateKey) || 0) + w._count.id);
    }

    const editsByDate = new Map<string, number>();
    for (const e of editsPerDay) {
      const dateKey = e.createdAt.toISOString().split('T')[0];
      editsByDate.set(dateKey, (editsByDate.get(dateKey) || 0) + e._count.id);
    }

    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];
      result.push({
        date: dateKey,
        websitesCreated: websitesByDate.get(dateKey) || 0,
        edits: editsByDate.get(dateKey) || 0,
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return result;
  }

  async getStatusChanges(daysAgo: number) {
    const prisma = this.fastify.prisma;

    // Get current counts by status
    const currentCounts = await prisma.website.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { status: true },
    });

    // Calculate the date X days ago
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - daysAgo);
    pastDate.setHours(0, 0, 0, 0);

    // To get past counts, we need to reconstruct the state at that point
    // We'll use audit logs to track changes and work backwards

    // Get all status changes since the past date
    const statusChanges = await prisma.auditLog.findMany({
      where: {
        entity: 'Website',
        action: 'UPDATE',
        createdAt: { gte: pastDate },
      },
      select: {
        entityId: true,
        oldValues: true,
        newValues: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get websites created after pastDate (they didn't exist before)
    const newWebsites = await prisma.website.findMany({
      where: {
        deletedAt: null,
        createdAt: { gte: pastDate },
      },
      select: { id: true, status: true },
    });

    // Get websites deleted after pastDate (they existed before)
    const deletedWebsites = await prisma.website.findMany({
      where: {
        deletedAt: { gte: pastDate },
      },
      select: { id: true, status: true },
    });

    // Build current status map
    const currentStatusMap: Record<string, number> = {
      NEW: 0,
      CHECKING: 0,
      HANDING: 0,
      PENDING: 0,
      RUNNING: 0,
      ERROR: 0,
      MAINTENANCE: 0,
    };

    for (const c of currentCounts) {
      currentStatusMap[c.status] = (c._count as { status: number })?.status ?? 0;
    }

    // Calculate past counts by reversing changes
    const pastStatusMap = { ...currentStatusMap };

    // Remove websites that were created after pastDate (they didn't exist)
    const newWebsiteIds = new Set(newWebsites.map(w => w.id));
    for (const w of newWebsites) {
      pastStatusMap[w.status]--;
    }

    // Add back websites that were deleted after pastDate (they existed)
    for (const w of deletedWebsites) {
      pastStatusMap[w.status]++;
    }

    // Track which websites we've already processed the earliest change for
    const processedWebsites = new Set<string>();

    // Reverse status changes (from newest to oldest)
    for (const change of statusChanges) {
      if (!change.entityId) continue;

      // Skip if this website was created after pastDate
      if (newWebsiteIds.has(change.entityId)) continue;

      // Only process each website once (we want the net change)
      if (processedWebsites.has(change.entityId)) continue;

      const oldValues = change.oldValues as Record<string, unknown> | null;
      const newValues = change.newValues as Record<string, unknown> | null;

      if (!oldValues || !newValues) continue;

      const oldStatus = oldValues.status as string | undefined;
      const newStatus = newValues.status as string | undefined;

      if (!oldStatus || !newStatus || oldStatus === newStatus) continue;

      // Reverse the change: current has newStatus, past had oldStatus
      pastStatusMap[newStatus]--;
      pastStatusMap[oldStatus]++;

      processedWebsites.add(change.entityId);
    }

    // Calculate differences
    const changes = {
      NEW: {
        current: currentStatusMap.NEW,
        past: Math.max(0, pastStatusMap.NEW),
        change: currentStatusMap.NEW - Math.max(0, pastStatusMap.NEW),
      },
      CHECKING: {
        current: currentStatusMap.CHECKING,
        past: Math.max(0, pastStatusMap.CHECKING),
        change: currentStatusMap.CHECKING - Math.max(0, pastStatusMap.CHECKING),
      },
      HANDING: {
        current: currentStatusMap.HANDING,
        past: Math.max(0, pastStatusMap.HANDING),
        change: currentStatusMap.HANDING - Math.max(0, pastStatusMap.HANDING),
      },
      PENDING: {
        current: currentStatusMap.PENDING,
        past: Math.max(0, pastStatusMap.PENDING),
        change: currentStatusMap.PENDING - Math.max(0, pastStatusMap.PENDING),
      },
      RUNNING: {
        current: currentStatusMap.RUNNING,
        past: Math.max(0, pastStatusMap.RUNNING),
        change: currentStatusMap.RUNNING - Math.max(0, pastStatusMap.RUNNING),
      },
      ERROR: {
        current: currentStatusMap.ERROR,
        past: Math.max(0, pastStatusMap.ERROR),
        change: currentStatusMap.ERROR - Math.max(0, pastStatusMap.ERROR),
      },
      MAINTENANCE: {
        current: currentStatusMap.MAINTENANCE,
        past: Math.max(0, pastStatusMap.MAINTENANCE),
        change: currentStatusMap.MAINTENANCE - Math.max(0, pastStatusMap.MAINTENANCE),
      },
    };

    // Calculate totals
    const totalCurrent = Object.values(currentStatusMap).reduce((a, b) => a + b, 0);
    const totalPast = Object.values(pastStatusMap).reduce((a, b) => Math.max(0, a) + Math.max(0, b), 0);

    return {
      period: `${daysAgo} days`,
      changes,
      summary: {
        totalCurrent,
        totalPast: Math.max(0, totalPast),
        totalChange: totalCurrent - Math.max(0, totalPast),
      },
    };
  }

  // ============ CTV Statistics Methods ============

  // Price per completed website (PENDING + RUNNING) (VND)
  private readonly PRICE_PER_COMPLETED_WEBSITE = 20000;

  async getCTVOverview(userId: string) {
    const prisma = this.fastify.prisma;

    // Get total websites added by this CTV
    const totalWebsites = await prisma.website.count({
      where: {
        deletedAt: null,
        createdBy: userId,
      },
    });

    // Get status counts for websites added by this CTV
    const statusCounts = await prisma.website.groupBy({
      by: ['status'],
      where: {
        deletedAt: null,
        createdBy: userId,
      },
      _count: { status: true },
    });

    // Get type counts for websites added by this CTV
    const typeCounts = await prisma.website.groupBy({
      by: ['type'],
      where: {
        deletedAt: null,
        createdBy: userId,
      },
      _count: { type: true },
    });

    // Get websites added this week by CTV
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const websitesThisWeek = await prisma.website.count({
      where: {
        deletedAt: null,
        createdBy: userId,
        createdAt: { gte: oneWeekAgo },
      },
    });

    // Get completed count for income calculation (PENDING + RUNNING)
    const pendingItem = statusCounts.find((s) => s.status === 'PENDING');
    const pendingCount = (pendingItem?._count as { status: number })?.status ?? 0;
    const runningItem = statusCounts.find((s) => s.status === 'RUNNING');
    const runningCount = (runningItem?._count as { status: number })?.status ?? 0;
    const completedCount = pendingCount + runningCount;
    const estimatedIncome = completedCount * this.PRICE_PER_COMPLETED_WEBSITE;

    return {
      totalWebsites,
      websitesThisWeek,
      completedCount,
      estimatedIncome,
      pricePerWebsite: this.PRICE_PER_COMPLETED_WEBSITE,
      statusCounts: statusCounts.map((s) => ({
        status: s.status,
        count: (s._count as { status: number })?.status ?? 0,
      })),
      typeCounts: typeCounts.map((t) => ({
        type: t.type,
        count: (t._count as { type: number })?.type ?? 0,
      })),
    };
  }

  async getCTVByStatus(userId: string) {
    const prisma = this.fastify.prisma;

    const stats = await prisma.website.groupBy({
      by: ['status'],
      where: {
        deletedAt: null,
        createdBy: userId,
      },
      _count: { status: true },
    });

    const total = stats.reduce((sum, s) => sum + ((s._count as { status: number })?.status ?? 0), 0);

    return stats.map((s) => {
      const count = (s._count as { status: number })?.status ?? 0;
      return {
        status: s.status,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100 * 100) / 100 : 0,
      };
    });
  }

  async getCTVByType(userId: string) {
    const prisma = this.fastify.prisma;

    const stats = await prisma.website.groupBy({
      by: ['type'],
      where: {
        deletedAt: null,
        createdBy: userId,
      },
      _count: { type: true },
    });

    const total = stats.reduce((sum, s) => sum + ((s._count as { type: number })?.type ?? 0), 0);

    return stats.map((s) => {
      const count = (s._count as { type: number })?.type ?? 0;
      return {
        type: s.type,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100 * 100) / 100 : 0,
      };
    });
  }

  async getCTVDailyTrends(userId: string, startDate: Date, endDate: Date) {
    const prisma = this.fastify.prisma;

    // Get websites created by this CTV grouped by date
    const websites = await prisma.website.findMany({
      where: {
        deletedAt: null,
        createdBy: userId,
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        createdAt: true,
      },
    });

    // Count websites by date
    const websitesByDate = new Map<string, number>();
    for (const w of websites) {
      const dateKey = w.createdAt.toISOString().split('T')[0];
      websitesByDate.set(dateKey, (websitesByDate.get(dateKey) || 0) + 1);
    }

    // Build result array
    const result: { date: string; websitesCreated: number }[] = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];
      result.push({
        date: dateKey,
        websitesCreated: websitesByDate.get(dateKey) || 0,
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return result;
  }

  async getCTVStatusChanges(userId: string, daysAgo: number) {
    const prisma = this.fastify.prisma;

    // Get current counts by status for this CTV's websites
    const currentCounts = await prisma.website.groupBy({
      by: ['status'],
      where: {
        deletedAt: null,
        createdBy: userId,
      },
      _count: { status: true },
    });

    // Calculate the date X days ago
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - daysAgo);
    pastDate.setHours(0, 0, 0, 0);

    // Get all websites created by this CTV
    const ctvWebsiteIds = await prisma.website.findMany({
      where: {
        createdBy: userId,
      },
      select: { id: true },
    });
    const ctvWebsiteIdSet = new Set(ctvWebsiteIds.map(w => w.id));

    // Get all status changes since the past date for CTV's websites
    const statusChanges = await prisma.auditLog.findMany({
      where: {
        entity: 'Website',
        action: 'UPDATE',
        createdAt: { gte: pastDate },
        entityId: { in: Array.from(ctvWebsiteIdSet) },
      },
      select: {
        entityId: true,
        oldValues: true,
        newValues: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get CTV's websites created after pastDate
    const newWebsites = await prisma.website.findMany({
      where: {
        deletedAt: null,
        createdBy: userId,
        createdAt: { gte: pastDate },
      },
      select: { id: true, status: true },
    });

    // Get CTV's websites deleted after pastDate
    const deletedWebsites = await prisma.website.findMany({
      where: {
        createdBy: userId,
        deletedAt: { gte: pastDate },
      },
      select: { id: true, status: true },
    });

    // Build current status map
    const currentStatusMap: Record<string, number> = {
      NEW: 0,
      CHECKING: 0,
      HANDING: 0,
      PENDING: 0,
      RUNNING: 0,
      ERROR: 0,
      MAINTENANCE: 0,
    };

    for (const c of currentCounts) {
      currentStatusMap[c.status] = (c._count as { status: number })?.status ?? 0;
    }

    // Calculate past counts by reversing changes
    const pastStatusMap = { ...currentStatusMap };
    const newWebsiteIds = new Set(newWebsites.map(w => w.id));

    for (const w of newWebsites) {
      pastStatusMap[w.status]--;
    }

    for (const w of deletedWebsites) {
      pastStatusMap[w.status]++;
    }

    const processedWebsites = new Set<string>();

    for (const change of statusChanges) {
      if (!change.entityId) continue;
      if (newWebsiteIds.has(change.entityId)) continue;
      if (processedWebsites.has(change.entityId)) continue;

      const oldValues = change.oldValues as Record<string, unknown> | null;
      const newValues = change.newValues as Record<string, unknown> | null;

      if (!oldValues || !newValues) continue;

      const oldStatus = oldValues.status as string | undefined;
      const newStatus = newValues.status as string | undefined;

      if (!oldStatus || !newStatus || oldStatus === newStatus) continue;

      pastStatusMap[newStatus]--;
      pastStatusMap[oldStatus]++;

      processedWebsites.add(change.entityId);
    }

    // Calculate differences
    const changes = {
      NEW: {
        current: currentStatusMap.NEW,
        past: Math.max(0, pastStatusMap.NEW),
        change: currentStatusMap.NEW - Math.max(0, pastStatusMap.NEW),
      },
      CHECKING: {
        current: currentStatusMap.CHECKING,
        past: Math.max(0, pastStatusMap.CHECKING),
        change: currentStatusMap.CHECKING - Math.max(0, pastStatusMap.CHECKING),
      },
      HANDING: {
        current: currentStatusMap.HANDING,
        past: Math.max(0, pastStatusMap.HANDING),
        change: currentStatusMap.HANDING - Math.max(0, pastStatusMap.HANDING),
      },
      PENDING: {
        current: currentStatusMap.PENDING,
        past: Math.max(0, pastStatusMap.PENDING),
        change: currentStatusMap.PENDING - Math.max(0, pastStatusMap.PENDING),
      },
      RUNNING: {
        current: currentStatusMap.RUNNING,
        past: Math.max(0, pastStatusMap.RUNNING),
        change: currentStatusMap.RUNNING - Math.max(0, pastStatusMap.RUNNING),
      },
      ERROR: {
        current: currentStatusMap.ERROR,
        past: Math.max(0, pastStatusMap.ERROR),
        change: currentStatusMap.ERROR - Math.max(0, pastStatusMap.ERROR),
      },
      MAINTENANCE: {
        current: currentStatusMap.MAINTENANCE,
        past: Math.max(0, pastStatusMap.MAINTENANCE),
        change: currentStatusMap.MAINTENANCE - Math.max(0, pastStatusMap.MAINTENANCE),
      },
    };

    const totalCurrent = Object.values(currentStatusMap).reduce((a, b) => a + b, 0);
    const totalPast = Object.values(pastStatusMap).reduce((a, b) => Math.max(0, a) + Math.max(0, b), 0);

    // Calculate income: completed websites (PENDING + RUNNING) * price
    const currentCompleted = currentStatusMap.PENDING + currentStatusMap.RUNNING;
    const pastCompleted = Math.max(0, pastStatusMap.PENDING) + Math.max(0, pastStatusMap.RUNNING);
    const currentIncome = currentCompleted * this.PRICE_PER_COMPLETED_WEBSITE;
    const pastIncome = pastCompleted * this.PRICE_PER_COMPLETED_WEBSITE;

    return {
      period: `${daysAgo} days`,
      changes,
      summary: {
        totalCurrent,
        totalPast: Math.max(0, totalPast),
        totalChange: totalCurrent - Math.max(0, totalPast),
      },
      income: {
        current: currentIncome,
        past: pastIncome,
        change: currentIncome - pastIncome,
        pricePerWebsite: this.PRICE_PER_COMPLETED_WEBSITE,
      },
    };
  }

  async getCTVIncomeStats(userId: string, startDate: Date, endDate: Date) {
    const prisma = this.fastify.prisma;

    // Get all completed websites (PENDING + RUNNING) by this CTV with their dates
    const completedWebsites = await prisma.website.findMany({
      where: {
        deletedAt: null,
        createdBy: userId,
        status: { in: ['PENDING', 'RUNNING'] },
      },
      select: {
        id: true,
        domain: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    // Calculate total income from completed websites
    const totalCompletedCount = completedWebsites.length;
    const totalIncome = totalCompletedCount * this.PRICE_PER_COMPLETED_WEBSITE;

    // Get websites that moved to PENDING or RUNNING status in the date range
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        entity: 'Website',
        action: 'UPDATE',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        entityId: true,
        newValues: true,
        oldValues: true,
        createdAt: true,
      },
    });

    // Get all CTV websites
    const allCtvWebsites = await prisma.website.findMany({
      where: { createdBy: userId },
      select: { id: true },
    });
    const allCtvWebsiteIds = new Set(allCtvWebsites.map(w => w.id));

    // Track which websites have already been counted as completed
    const countedWebsites = new Set<string>();
    const transitionsByDate = new Map<string, number>();

    for (const log of auditLogs) {
      if (!log.entityId || !allCtvWebsiteIds.has(log.entityId)) continue;
      if (countedWebsites.has(log.entityId)) continue;

      const newValues = log.newValues as Record<string, unknown> | null;
      const oldValues = log.oldValues as Record<string, unknown> | null;

      if (!newValues || !oldValues) continue;

      const newStatus = newValues.status as string | undefined;
      const oldStatus = oldValues.status as string | undefined;

      // Count when website first transitions to PENDING or RUNNING from a non-completed status
      const isNewCompleted = (newStatus === 'PENDING' || newStatus === 'RUNNING');
      const wasNotCompleted = (oldStatus !== 'PENDING' && oldStatus !== 'RUNNING');

      if (isNewCompleted && wasNotCompleted) {
        const dateKey = log.createdAt.toISOString().split('T')[0];
        transitionsByDate.set(dateKey, (transitionsByDate.get(dateKey) || 0) + 1);
        countedWebsites.add(log.entityId);
      }
    }

    // Build daily income array
    const dailyIncomeData: { date: string; count: number; income: number }[] = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];
      const count = transitionsByDate.get(dateKey) || 0;
      dailyIncomeData.push({
        date: dateKey,
        count,
        income: count * this.PRICE_PER_COMPLETED_WEBSITE,
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return {
      totalCompletedCount,
      totalIncome,
      pricePerWebsite: this.PRICE_PER_COMPLETED_WEBSITE,
      completedWebsites: completedWebsites.slice(0, 10), // Top 10 most recent
      dailyIncome: dailyIncomeData,
    };
  }

  // ============ DEV Statistics Methods ============

  /**
   * Get DEV overview statistics
   * - Websites fixed (edited by this DEV)
   * - Websites with errors
   * - Websites promoted (PENDING -> RUNNING)
   * - Success rate of websites edited by DEV
   */
  async getDEVOverview(userId: string) {
    const prisma = this.fastify.prisma;

    // Get all websites that this DEV has edited (from audit logs)
    const editedWebsiteIds = await this.getWebsitesEditedByUser(userId);

    // Get details of edited websites
    const editedWebsites = await prisma.website.findMany({
      where: {
        id: { in: editedWebsiteIds },
        deletedAt: null,
      },
      select: {
        id: true,
        status: true,
      },
    });

    // Count by status
    const totalFixed = editedWebsites.length;
    const errorCount = editedWebsites.filter(w => w.status === 'ERROR').length;
    const runningCount = editedWebsites.filter(w => w.status === 'RUNNING').length;
    const pendingCount = editedWebsites.filter(w => w.status === 'PENDING').length;

    // Get websites promoted from PENDING to RUNNING by this DEV
    const promotedCount = await this.getPromotedWebsitesCount(userId);

    // Calculate success rate from allocation data
    const successRateData = await this.calculateDevSuccessRate(editedWebsiteIds);

    // Get websites fixed this week
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const fixedThisWeek = await prisma.auditLog.findMany({
      where: {
        userId,
        entity: 'Website',
        action: 'UPDATE',
        createdAt: { gte: oneWeekAgo },
      },
      select: { entityId: true },
      distinct: ['entityId'],
    });

    return {
      totalFixed,
      fixedThisWeek: fixedThisWeek.length,
      errorCount,
      runningCount,
      pendingCount,
      promotedCount,
      successRate: successRateData.successRate,
      totalAllocations: successRateData.totalAllocations,
      successAllocations: successRateData.successAllocations,
    };
  }

  /**
   * Get list of website IDs edited by a user
   */
  private async getWebsitesEditedByUser(userId: string): Promise<string[]> {
    const prisma = this.fastify.prisma;

    const edits = await prisma.auditLog.findMany({
      where: {
        userId,
        entity: 'Website',
        action: 'UPDATE',
      },
      select: { entityId: true },
      distinct: ['entityId'],
    });

    return edits.map(e => e.entityId).filter((id): id is string => id !== null);
  }

  /**
   * Count websites promoted from PENDING to RUNNING by this DEV
   */
  private async getPromotedWebsitesCount(userId: string): Promise<number> {
    const prisma = this.fastify.prisma;

    const promotions = await prisma.auditLog.findMany({
      where: {
        userId,
        entity: 'Website',
        action: 'UPDATE',
      },
      select: {
        entityId: true,
        oldValues: true,
        newValues: true,
      },
    });

    let count = 0;
    const countedWebsites = new Set<string>();

    for (const log of promotions) {
      if (!log.entityId || countedWebsites.has(log.entityId)) continue;

      const oldValues = log.oldValues as Record<string, unknown> | null;
      const newValues = log.newValues as Record<string, unknown> | null;

      if (!oldValues || !newValues) continue;

      const oldStatus = oldValues.status as string | undefined;
      const newStatus = newValues.status as string | undefined;

      if (oldStatus === 'PENDING' && newStatus === 'RUNNING') {
        count++;
        countedWebsites.add(log.entityId);
      }
    }

    return count;
  }

  /**
   * Calculate success rate for websites edited by DEV
   */
  private async calculateDevSuccessRate(websiteIds: string[]): Promise<{
    successRate: number;
    totalAllocations: number;
    successAllocations: number;
  }> {
    if (websiteIds.length === 0) {
      return { successRate: 0, totalAllocations: 0, successAllocations: 0 };
    }

    const prisma = this.fastify.prisma;

    const stats = await prisma.dailyAllocation.aggregate({
      where: {
        websiteId: { in: websiteIds },
      },
      _sum: {
        allocationCount: true,
        successCount: true,
      },
    });

    const totalAllocations = stats._sum.allocationCount || 0;
    const successAllocations = stats._sum.successCount || 0;
    const successRate = totalAllocations > 0
      ? Math.round((successAllocations / totalAllocations) * 100 * 100) / 100
      : 0;

    return { successRate, totalAllocations, successAllocations };
  }

  /**
   * Get DEV statistics by status for websites they edited
   */
  async getDEVByStatus(userId: string) {
    const prisma = this.fastify.prisma;

    const editedWebsiteIds = await this.getWebsitesEditedByUser(userId);

    const stats = await prisma.website.groupBy({
      by: ['status'],
      where: {
        id: { in: editedWebsiteIds },
        deletedAt: null,
      },
      _count: { status: true },
    });

    const total = stats.reduce((sum, s) => sum + ((s._count as { status: number })?.status ?? 0), 0);

    return stats.map((s) => {
      const count = (s._count as { status: number })?.status ?? 0;
      return {
        status: s.status,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100 * 100) / 100 : 0,
      };
    });
  }

  /**
   * Get DEV daily trends - websites fixed per day
   */
  async getDEVDailyTrends(userId: string, startDate: Date, endDate: Date) {
    const prisma = this.fastify.prisma;

    // Get edits by this DEV in the date range
    const edits = await prisma.auditLog.findMany({
      where: {
        userId,
        entity: 'Website',
        action: 'UPDATE',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        entityId: true,
        createdAt: true,
      },
    });

    // Count unique websites edited per day
    const editsByDate = new Map<string, Set<string>>();
    for (const edit of edits) {
      if (!edit.entityId) continue;
      const dateKey = edit.createdAt.toISOString().split('T')[0];
      if (!editsByDate.has(dateKey)) {
        editsByDate.set(dateKey, new Set());
      }
      editsByDate.get(dateKey)!.add(edit.entityId);
    }

    // Build result array
    const result: { date: string; websitesFixed: number }[] = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];
      result.push({
        date: dateKey,
        websitesFixed: editsByDate.get(dateKey)?.size || 0,
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return result;
  }

  /**
   * Get DEV status changes - compare current vs past
   */
  async getDEVStatusChanges(userId: string, daysAgo: number) {
    const prisma = this.fastify.prisma;

    const editedWebsiteIds = await this.getWebsitesEditedByUser(userId);

    // Get current counts by status
    const currentCounts = await prisma.website.groupBy({
      by: ['status'],
      where: {
        id: { in: editedWebsiteIds },
        deletedAt: null,
      },
      _count: { status: true },
    });

    // Calculate the date X days ago
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - daysAgo);
    pastDate.setHours(0, 0, 0, 0);

    // Get status changes since pastDate for these websites
    const statusChanges = await prisma.auditLog.findMany({
      where: {
        entity: 'Website',
        action: 'UPDATE',
        entityId: { in: editedWebsiteIds },
        createdAt: { gte: pastDate },
      },
      select: {
        entityId: true,
        oldValues: true,
        newValues: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Build current status map
    const currentStatusMap: Record<string, number> = {
      NEW: 0,
      CHECKING: 0,
      HANDING: 0,
      PENDING: 0,
      RUNNING: 0,
      ERROR: 0,
      MAINTENANCE: 0,
    };

    for (const c of currentCounts) {
      currentStatusMap[c.status] = (c._count as { status: number })?.status ?? 0;
    }

    // Calculate past counts by reversing changes
    const pastStatusMap = { ...currentStatusMap };
    const processedWebsites = new Set<string>();

    for (const change of statusChanges) {
      if (!change.entityId) continue;
      if (processedWebsites.has(change.entityId)) continue;

      const oldValues = change.oldValues as Record<string, unknown> | null;
      const newValues = change.newValues as Record<string, unknown> | null;

      if (!oldValues || !newValues) continue;

      const oldStatus = oldValues.status as string | undefined;
      const newStatus = newValues.status as string | undefined;

      if (!oldStatus || !newStatus || oldStatus === newStatus) continue;

      pastStatusMap[newStatus]--;
      pastStatusMap[oldStatus]++;

      processedWebsites.add(change.entityId);
    }

    // Calculate differences
    const changes = {
      NEW: {
        current: currentStatusMap.NEW,
        past: Math.max(0, pastStatusMap.NEW),
        change: currentStatusMap.NEW - Math.max(0, pastStatusMap.NEW),
      },
      CHECKING: {
        current: currentStatusMap.CHECKING,
        past: Math.max(0, pastStatusMap.CHECKING),
        change: currentStatusMap.CHECKING - Math.max(0, pastStatusMap.CHECKING),
      },
      HANDING: {
        current: currentStatusMap.HANDING,
        past: Math.max(0, pastStatusMap.HANDING),
        change: currentStatusMap.HANDING - Math.max(0, pastStatusMap.HANDING),
      },
      PENDING: {
        current: currentStatusMap.PENDING,
        past: Math.max(0, pastStatusMap.PENDING),
        change: currentStatusMap.PENDING - Math.max(0, pastStatusMap.PENDING),
      },
      RUNNING: {
        current: currentStatusMap.RUNNING,
        past: Math.max(0, pastStatusMap.RUNNING),
        change: currentStatusMap.RUNNING - Math.max(0, pastStatusMap.RUNNING),
      },
      ERROR: {
        current: currentStatusMap.ERROR,
        past: Math.max(0, pastStatusMap.ERROR),
        change: currentStatusMap.ERROR - Math.max(0, pastStatusMap.ERROR),
      },
      MAINTENANCE: {
        current: currentStatusMap.MAINTENANCE,
        past: Math.max(0, pastStatusMap.MAINTENANCE),
        change: currentStatusMap.MAINTENANCE - Math.max(0, pastStatusMap.MAINTENANCE),
      },
    };

    const totalCurrent = Object.values(currentStatusMap).reduce((a, b) => a + b, 0);
    const totalPast = Object.values(pastStatusMap).reduce((a, b) => Math.max(0, a) + Math.max(0, b), 0);

    return {
      period: `${daysAgo} days`,
      changes,
      summary: {
        totalCurrent,
        totalPast: Math.max(0, totalPast),
        totalChange: totalCurrent - Math.max(0, totalPast),
      },
    };
  }

  /**
   * Get top websites by success rate for DEV
   */
  async getDEVTopWebsites(userId: string, limit: number = 10, sortBy: 'successRate' | 'allocations' = 'successRate') {
    const prisma = this.fastify.prisma;

    const editedWebsiteIds = await this.getWebsitesEditedByUser(userId);

    if (editedWebsiteIds.length === 0) {
      return [];
    }

    // Get allocation stats for these websites
    const websiteStats = await prisma.dailyAllocation.groupBy({
      by: ['websiteId'],
      where: {
        websiteId: { in: editedWebsiteIds },
      },
      _sum: {
        allocationCount: true,
        successCount: true,
        failureCount: true,
      },
    });

    // Get website details
    const websites = await prisma.website.findMany({
      where: {
        id: { in: editedWebsiteIds },
        deletedAt: null,
      },
      select: {
        id: true,
        domain: true,
        status: true,
        type: true,
      },
    });

    const websiteMap = new Map(websites.map(w => [w.id, w]));

    // Calculate stats and sort
    const result = websiteStats
      .map(ws => {
        const website = websiteMap.get(ws.websiteId);
        if (!website) return null;

        const allocations = ws._sum.allocationCount || 0;
        const success = ws._sum.successCount || 0;
        const failure = ws._sum.failureCount || 0;
        const successRate = allocations > 0
          ? Math.round((success / allocations) * 100 * 100) / 100
          : 0;

        return {
          websiteId: ws.websiteId,
          domain: website.domain,
          status: website.status,
          type: website.type,
          allocations,
          success,
          failure,
          successRate,
        };
      })
      .filter((w): w is NonNullable<typeof w> => w !== null)
      .sort((a, b) => {
        if (sortBy === 'successRate') {
          return b.successRate - a.successRate;
        }
        return b.allocations - a.allocations;
      })
      .slice(0, limit);

    return result;
  }

  /**
   * Get error websites for DEV
   */
  async getDEVErrorWebsites(userId: string) {
    const prisma = this.fastify.prisma;

    const editedWebsiteIds = await this.getWebsitesEditedByUser(userId);

    const errorWebsites = await prisma.website.findMany({
      where: {
        id: { in: editedWebsiteIds },
        status: 'ERROR',
        deletedAt: null,
      },
      select: {
        id: true,
        domain: true,
        notes: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return errorWebsites;
  }
}
