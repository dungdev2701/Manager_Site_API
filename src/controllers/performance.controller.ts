import { FastifyRequest, FastifyReply } from 'fastify';
import { PerformanceService } from '../services/performance.service';
import { ResponseHelper } from '../utils/response';
import { z } from 'zod';

// Validation schemas
const performanceQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  days: z.coerce.number().min(1).max(365).optional().default(30),
});

const compareQuerySchema = z.object({
  period1Start: z.string(),
  period1End: z.string(),
  period2Start: z.string(),
  period2End: z.string(),
});

export class PerformanceController {
  /**
   * Get website performance data
   * GET /websites/:id/performance
   */
  static async getPerformance(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };
    const query = performanceQuerySchema.parse(request.query);

    // Calculate date range
    let endDate = query.endDate ? new Date(query.endDate) : new Date();
    let startDate: Date;

    if (query.startDate) {
      startDate = new Date(query.startDate);
    } else {
      startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - query.days);
    }

    // Set time to start/end of day
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    const performanceService = new PerformanceService(request.server);
    const data = await performanceService.getWebsitePerformance(id, startDate, endDate);

    return ResponseHelper.success(reply, data);
  }

  /**
   * Compare performance between two periods
   * GET /websites/:id/performance/compare
   */
  static async comparePerformance(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return ResponseHelper.unauthorized(reply, 'Authentication required');
    }

    const { id } = request.params as { id: string };
    const query = compareQuerySchema.parse(request.query);

    const period1Start = new Date(query.period1Start);
    const period1End = new Date(query.period1End);
    const period2Start = new Date(query.period2Start);
    const period2End = new Date(query.period2End);

    // Set time boundaries
    period1Start.setHours(0, 0, 0, 0);
    period1End.setHours(23, 59, 59, 999);
    period2Start.setHours(0, 0, 0, 0);
    period2End.setHours(23, 59, 59, 999);

    const performanceService = new PerformanceService(request.server);
    const data = await performanceService.comparePerformance(
      id,
      period1Start,
      period1End,
      period2Start,
      period2End
    );

    return ResponseHelper.success(reply, data);
  }
}
