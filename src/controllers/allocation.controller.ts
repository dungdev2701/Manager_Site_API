import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { AllocationService } from '../services/allocation.service';

export class AllocationController {
  private service: AllocationService;

  constructor(fastify: FastifyInstance) {
    this.service = new AllocationService(fastify);
  }

  /**
   * GET /allocation/statistics
   * Get overall allocation statistics
   */
  async getStatistics(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const stats = await this.service.getStatistics();
    reply.send({
      success: true,
      data: stats,
    });
  }

  /**
   * POST /allocation/process
   * Trigger processing of pending requests from MySQL
   * Each tool pair can only be assigned to ONE request at a time
   */
  async processPendingRequests(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const result = await this.service.processPendingRequests();
    reply.send({
      success: true,
      message: 'Pending requests processed',
      data: result,
    });
  }

  /**
   * POST /allocation/sync
   * Sync results from completed MySQL requests
   */
  async syncCompletedRequests(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const result = await this.service.syncCompletedRequests();
    reply.send({
      success: true,
      data: result,
    });
  }

  /**
   * GET /allocation/request/:requestId
   * Get allocation results for a specific request
   */
  async getRequestResults(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const { requestId } = request.params as { requestId: string };
    const results = await this.service.getRequestAllocationResults(requestId);
    reply.send({
      success: true,
      data: results,
    });
  }

  /**
   * GET /allocation/website/:websiteId/stats
   * Get success rate and stats for a specific website
   */
  async getWebsiteStats(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const { websiteId } = request.params as { websiteId: string };
    const stats = await this.service.getWebsiteSuccessRate(websiteId);
    reply.send({
      success: true,
      data: stats,
    });
  }

  /**
   * GET /allocation/health
   * Check MySQL connection health
   */
  async healthCheck(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const fastify = request.server;

    if (!fastify.mysql) {
      reply.status(503).send({
        success: false,
        message: 'MySQL not configured',
      });
      return;
    }

    const isHealthy = await fastify.mysql.ping();
    if (isHealthy) {
      reply.send({
        success: true,
        message: 'MySQL connection healthy',
      });
    } else {
      reply.status(503).send({
        success: false,
        message: 'MySQL connection failed',
      });
    }
  }

  /**
   * POST /allocation/force-resync
   * Force resync tất cả allocation results từ MySQL
   * Bỏ qua điều kiện resultSyncedAt để sync lại tất cả
   */
  async forceResync(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const result = await this.service.forceResyncAllResults();
    reply.send({
      success: true,
      message: 'Force resync completed',
      data: result,
    });
  }

  /**
   * POST /allocation/recalculate-stats
   * Recalculate success rate cho tất cả websites
   * Dùng khi cần tính lại stats mà không cần sync từ MySQL
   */
  async recalculateStats(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const result = await this.service.recalculateAllWebsiteStats();
    reply.send({
      success: true,
      message: 'Stats recalculated',
      data: result,
    });
  }
}
