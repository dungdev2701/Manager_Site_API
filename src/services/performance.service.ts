import { FastifyInstance } from 'fastify';
import { PerformanceRepository } from '../repositories/performance.repository';

export interface PerformanceDataPoint {
  date: string; // ISO date string
  successRate: number | null; // null only when no historical data available
  allocationCount: number;
  successCount: number;
  failureCount: number;
  isCarriedForward?: boolean; // true if successRate is carried from previous day (no allocations today)
  // Editor info if there was an edit on this date
  editors?: {
    userId: string;
    userName: string | null;
    userEmail: string;
    editedAt: string;
    changes: Record<string, unknown>;
  }[];
}

// Stats for each editor's contribution period
export interface EditorPerformanceStats {
  userId: string;
  userName: string | null;
  userEmail: string;
  editedAt: string; // When they made the edit
  periodStart: string; // Start of their responsibility period
  periodEnd: string; // End of their responsibility period (next edit or endDate)
  totalAllocations: number;
  totalSuccess: number;
  totalFailure: number;
  successRate: number | null; // null if no allocations in period
}

export interface PerformanceResponse {
  website: {
    id: string;
    domain: string;
    status: string;
    type: string;
  };
  period: {
    startDate: string;
    endDate: string;
  };
  stats: {
    totalAllocations: number;
    totalSuccess: number;
    totalFailure: number;
    overallSuccessRate: number;
    editorCount: number;
  };
  editorStats: EditorPerformanceStats[]; // Stats per editor
  data: PerformanceDataPoint[];
}

export class PerformanceService {
  private performanceRepository: PerformanceRepository;

  constructor(private fastify: FastifyInstance) {
    this.performanceRepository = new PerformanceRepository(fastify.prisma);
  }

  /**
   * Get performance data for a website
   * Combines daily allocation data with edit events
   */
  async getWebsitePerformance(
    websiteId: string,
    startDate: Date,
    endDate: Date
  ): Promise<PerformanceResponse> {
    // Get website info
    const website = await this.performanceRepository.getWebsiteInfo(websiteId);
    if (!website) {
      throw this.fastify.httpErrors.notFound('Website not found');
    }

    // Get all data in parallel
    const [dailyPerformance, editEvents, overallStats, editorCount] = await Promise.all([
      this.performanceRepository.getDailyPerformance(websiteId, startDate, endDate),
      this.performanceRepository.getEditEvents(websiteId, startDate, endDate),
      this.performanceRepository.getOverallStats(websiteId, startDate, endDate),
      this.performanceRepository.getEditorCount(websiteId, startDate, endDate),
    ]);

    // Group edit events by date
    const editsByDate = new Map<string, typeof editEvents>();
    for (const edit of editEvents) {
      const dateKey = edit.date.toISOString().split('T')[0];
      if (!editsByDate.has(dateKey)) {
        editsByDate.set(dateKey, []);
      }
      editsByDate.get(dateKey)!.push(edit);
    }

    // Build data points - include all dates in range
    // Use "fill forward" strategy: if no allocation on a day, carry forward the last known success rate
    const dataPoints: PerformanceDataPoint[] = [];
    const currentDate = new Date(startDate);
    let lastKnownSuccessRate: number | null = null;

    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];

      // Find daily allocation for this date
      const dailyData = dailyPerformance.find(
        (dp) => dp.date.toISOString().split('T')[0] === dateKey
      );

      // Find edits for this date
      const editsOnDate = editsByDate.get(dateKey);

      // Determine success rate: use actual data if available, otherwise carry forward
      let successRate: number | null;
      let isCarriedForward = false;

      if (dailyData && dailyData.allocationCount > 0) {
        // Has actual allocation data for this day
        successRate = dailyData.successRate;
        lastKnownSuccessRate = successRate; // Update last known value
      } else {
        // No allocation on this day - carry forward the last known success rate
        successRate = lastKnownSuccessRate;
        isCarriedForward = lastKnownSuccessRate !== null;
      }

      dataPoints.push({
        date: dateKey,
        successRate,
        allocationCount: dailyData?.allocationCount || 0,
        successCount: dailyData?.successCount || 0,
        failureCount: dailyData?.failureCount || 0,
        isCarriedForward: isCarriedForward || undefined,
        editors: editsOnDate?.map((edit) => ({
          userId: edit.userId,
          userName: edit.userName,
          userEmail: edit.userEmail,
          editedAt: edit.date.toISOString(),
          changes: edit.changes,
        })),
      });

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Calculate editor stats - each editor's responsibility period
    const editorStats: EditorPerformanceStats[] = this.calculateEditorStats(
      editEvents,
      dailyPerformance,
      endDate
    );

    return {
      website: {
        id: website.id,
        domain: website.domain,
        status: website.status,
        type: website.type,
      },
      period: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      },
      stats: {
        ...overallStats,
        editorCount,
      },
      editorStats,
      data: dataPoints,
    };
  }

  /**
   * Calculate performance stats for each editor's responsibility period
   * Period starts from their edit date until the next edit (or endDate)
   */
  private calculateEditorStats(
    editEvents: { date: Date; userId: string; userName: string | null; userEmail: string; changes: Record<string, unknown> }[],
    dailyPerformance: { date: Date; allocationCount: number; successCount: number; failureCount: number; successRate: number }[],
    endDate: Date
  ): EditorPerformanceStats[] {
    if (editEvents.length === 0) {
      return [];
    }

    // Sort edits by date ascending
    const sortedEdits = [...editEvents].sort((a, b) => a.date.getTime() - b.date.getTime());

    // Group consecutive edits by the same user on the same day
    const consolidatedEdits: typeof sortedEdits = [];
    for (const edit of sortedEdits) {
      const editDateKey = edit.date.toISOString().split('T')[0];
      const lastEdit = consolidatedEdits[consolidatedEdits.length - 1];

      if (lastEdit) {
        const lastEditDateKey = lastEdit.date.toISOString().split('T')[0];
        // If same user on same day, skip (keep the first edit)
        if (lastEdit.userId === edit.userId && lastEditDateKey === editDateKey) {
          continue;
        }
      }
      consolidatedEdits.push(edit);
    }

    const stats: EditorPerformanceStats[] = [];

    for (let i = 0; i < consolidatedEdits.length; i++) {
      const edit = consolidatedEdits[i];
      const nextEdit = consolidatedEdits[i + 1];

      // Period starts from the day of edit
      const periodStart = new Date(edit.date);
      periodStart.setHours(0, 0, 0, 0);

      // Period ends at the day before next edit, or endDate if no next edit
      let periodEnd: Date;
      if (nextEdit) {
        periodEnd = new Date(nextEdit.date);
        periodEnd.setHours(0, 0, 0, 0);
        periodEnd.setDate(periodEnd.getDate() - 1);
        // If next edit is on the same day, skip this editor's stats
        if (periodEnd < periodStart) {
          continue;
        }
      } else {
        periodEnd = new Date(endDate);
      }

      // Calculate stats for this period
      let totalAllocations = 0;
      let totalSuccess = 0;
      let totalFailure = 0;

      for (const dp of dailyPerformance) {
        const dpDate = new Date(dp.date);
        dpDate.setHours(0, 0, 0, 0);

        if (dpDate >= periodStart && dpDate <= periodEnd) {
          totalAllocations += dp.allocationCount;
          totalSuccess += dp.successCount;
          totalFailure += dp.failureCount;
        }
      }

      const successRate = totalAllocations > 0
        ? Math.round((totalSuccess / totalAllocations) * 100 * 100) / 100
        : null;

      stats.push({
        userId: edit.userId,
        userName: edit.userName,
        userEmail: edit.userEmail,
        editedAt: edit.date.toISOString(),
        periodStart: periodStart.toISOString().split('T')[0],
        periodEnd: periodEnd.toISOString().split('T')[0],
        totalAllocations,
        totalSuccess,
        totalFailure,
        successRate,
      });
    }

    return stats;
  }

  /**
   * Get performance comparison between periods
   * Useful to see improvement after an edit
   */
  async comparePerformance(
    websiteId: string,
    period1Start: Date,
    period1End: Date,
    period2Start: Date,
    period2End: Date
  ) {
    const [stats1, stats2] = await Promise.all([
      this.performanceRepository.getOverallStats(websiteId, period1Start, period1End),
      this.performanceRepository.getOverallStats(websiteId, period2Start, period2End),
    ]);

    const improvement = stats2.overallSuccessRate - stats1.overallSuccessRate;

    return {
      period1: {
        start: period1Start.toISOString().split('T')[0],
        end: period1End.toISOString().split('T')[0],
        ...stats1,
      },
      period2: {
        start: period2Start.toISOString().split('T')[0],
        end: period2End.toISOString().split('T')[0],
        ...stats2,
      },
      improvement: {
        successRateChange: Math.round(improvement * 100) / 100,
        improved: improvement > 0,
      },
    };
  }
}
