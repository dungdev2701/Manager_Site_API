import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { StatisticsService } from '../services/statistics.service';

interface DateRangeQuery {
  startDate?: string;
  endDate?: string;
  days?: string;
}

interface TopWebsitesQuery extends DateRangeQuery {
  limit?: string;
  sortBy?: 'successRate' | 'allocations' | 'success' | 'failure';
  order?: 'asc' | 'desc';
}

interface DEVTopWebsitesQuery {
  limit?: string;
  sortBy?: 'successRate' | 'allocations';
}

export class StatisticsController {
  private statisticsService: StatisticsService;

  constructor(fastify: FastifyInstance) {
    this.statisticsService = new StatisticsService(fastify);
  }

  async getOverview(request: FastifyRequest, reply: FastifyReply) {
    const overview = await this.statisticsService.getOverview();
    return reply.send({
      success: true,
      data: overview,
    });
  }

  async getByStatus(request: FastifyRequest, reply: FastifyReply) {
    const stats = await this.statisticsService.getByStatus();
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getByType(request: FastifyRequest, reply: FastifyReply) {
    const stats = await this.statisticsService.getByType();
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getAllocationStats(request: FastifyRequest, reply: FastifyReply) {
    const { startDate, endDate, days } = request.query as DateRangeQuery;

    let start: Date;
    let end: Date = new Date();

    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      const daysNum = days ? parseInt(days) : 30;
      start = new Date();
      start.setDate(start.getDate() - daysNum);
    }

    const stats = await this.statisticsService.getAllocationStats(start, end);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getTopWebsites(request: FastifyRequest, reply: FastifyReply) {
    const { startDate, endDate, days, limit, sortBy, order } = request.query as TopWebsitesQuery;

    let start: Date;
    let end: Date = new Date();

    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      const daysNum = days ? parseInt(days) : 30;
      start = new Date();
      start.setDate(start.getDate() - daysNum);
    }

    const stats = await this.statisticsService.getTopWebsites(
      start,
      end,
      limit ? parseInt(limit) : 10,
      sortBy || 'successRate',
      order || 'desc'
    );
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getEditorStats(request: FastifyRequest, reply: FastifyReply) {
    const { startDate, endDate, days } = request.query as DateRangeQuery;

    let start: Date;
    let end: Date = new Date();

    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      const daysNum = days ? parseInt(days) : 30;
      start = new Date();
      start.setDate(start.getDate() - daysNum);
    }

    const stats = await this.statisticsService.getEditorStats(start, end);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getDailyTrends(request: FastifyRequest, reply: FastifyReply) {
    const { startDate, endDate, days } = request.query as DateRangeQuery;

    let start: Date;
    let end: Date = new Date();

    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      const daysNum = days ? parseInt(days) : 30;
      start = new Date();
      start.setDate(start.getDate() - daysNum);
    }

    const stats = await this.statisticsService.getDailyTrends(start, end);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getStatusChanges(request: FastifyRequest, reply: FastifyReply) {
    const { days } = request.query as DateRangeQuery;
    const daysNum = days ? parseInt(days) : 30;

    const stats = await this.statisticsService.getStatusChanges(daysNum);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  // ============ CTV Statistics Endpoints ============

  async getCTVOverview(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const overview = await this.statisticsService.getCTVOverview(userId);
    return reply.send({
      success: true,
      data: overview,
    });
  }

  async getCTVByStatus(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const stats = await this.statisticsService.getCTVByStatus(userId);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getCTVByType(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const stats = await this.statisticsService.getCTVByType(userId);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getCTVDailyTrends(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const { startDate, endDate, days } = request.query as DateRangeQuery;

    let start: Date;
    let end: Date = new Date();

    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      const daysNum = days ? parseInt(days) : 30;
      start = new Date();
      start.setDate(start.getDate() - daysNum);
    }

    const stats = await this.statisticsService.getCTVDailyTrends(userId, start, end);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getCTVStatusChanges(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const { days } = request.query as DateRangeQuery;
    const daysNum = days ? parseInt(days) : 30;

    const stats = await this.statisticsService.getCTVStatusChanges(userId, daysNum);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getCTVIncomeStats(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const { startDate, endDate, days } = request.query as DateRangeQuery;

    let start: Date;
    let end: Date = new Date();

    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      const daysNum = days ? parseInt(days) : 30;
      start = new Date();
      start.setDate(start.getDate() - daysNum);
    }

    const stats = await this.statisticsService.getCTVIncomeStats(userId, start, end);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  // ============ DEV Statistics Endpoints ============

  async getDEVOverview(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const overview = await this.statisticsService.getDEVOverview(userId);
    return reply.send({
      success: true,
      data: overview,
    });
  }

  async getDEVByStatus(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const stats = await this.statisticsService.getDEVByStatus(userId);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getDEVDailyTrends(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const { startDate, endDate, days } = request.query as DateRangeQuery;

    let start: Date;
    let end: Date = new Date();

    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
    } else {
      const daysNum = days ? parseInt(days) : 30;
      start = new Date();
      start.setDate(start.getDate() - daysNum);
    }

    const stats = await this.statisticsService.getDEVDailyTrends(userId, start, end);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getDEVStatusChanges(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const { days } = request.query as DateRangeQuery;
    const daysNum = days ? parseInt(days) : 30;

    const stats = await this.statisticsService.getDEVStatusChanges(userId, daysNum);
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getDEVTopWebsites(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const { limit, sortBy } = request.query as DEVTopWebsitesQuery;

    const stats = await this.statisticsService.getDEVTopWebsites(
      userId,
      limit ? parseInt(limit) : 10,
      sortBy || 'successRate'
    );
    return reply.send({
      success: true,
      data: stats,
    });
  }

  async getDEVErrorWebsites(request: FastifyRequest, reply: FastifyReply) {
    const userId = (request as any).user.id;
    const stats = await this.statisticsService.getDEVErrorWebsites(userId);
    return reply.send({
      success: true,
      data: stats,
    });
  }
}
