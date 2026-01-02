import { FastifyInstance } from 'fastify';
import {
  MySQLExternalRepositories,
  EntityRequest,
  EntityRequestRepository,
  LinkStatusCount,
} from '../repositories/mysql-external';

/**
 * Service kiểm tra và cập nhật trạng thái request
 *
 * Logic:
 * 1. Request đang "running":
 *    - Nếu số link finish >= 110% entity_limit -> chuyển sang "connecting", cancel các link "new"
 *    - Nếu quá timeout -> chuyển sang "connecting", new -> cancel, finish -> connect
 *
 * 2. Request đang "connecting":
 *    - Nếu không còn link nào ở trạng thái xử lý (connecting, connect)
 *      -> chuyển sang "completed"
 *    - HOẶC nếu quá thời gian connecting timeout (= 1/6 running timeout)
 *      -> update các link stuck sang fail status:
 *         + connect/connecting -> fail connecting
 *         + registering -> fail registering
 *         + profiling -> fail profiling
 *      -> chuyển sang "completed"
 */
export class RequestStatusCheckerService {
  private mysqlRepo: MySQLExternalRepositories;

  constructor(private fastify: FastifyInstance) {
    this.mysqlRepo = new MySQLExternalRepositories(fastify.mysql);
  }

  /**
   * Chạy kiểm tra tất cả request đang running và connecting
   * Tối ưu: Sử dụng batch queries để giảm số lượng roundtrips đến DB
   */
  async checkAll(): Promise<{
    runningChecked: number;
    connectingChecked: number;
    transitionedToConnecting: number;
    transitionedToCompleted: number;
    timedOut: number;
    connectingTimedOut: number;
  }> {
    const result = {
      runningChecked: 0,
      connectingChecked: 0,
      transitionedToConnecting: 0,
      transitionedToCompleted: 0,
      timedOut: 0,
      connectingTimedOut: 0,
    };

    // 1. Check running requests
    const runningRequests = await this.mysqlRepo.entityRequest.findRunning();
    result.runningChecked = runningRequests.length;

    if (runningRequests.length > 0) {
      // Batch query: lấy link counts cho tất cả running requests cùng lúc
      const runningIds = runningRequests.map((r) => r.id);
      const linkCountsMap = await this.mysqlRepo.entityLink.countByStatusBatch(runningIds);

      for (const request of runningRequests) {
        const linkCounts = linkCountsMap.get(String(request.id));
        if (!linkCounts) continue;

        const transitioned = await this.checkRunningRequestWithCounts(request, linkCounts);
        if (transitioned === 'connecting') {
          result.transitionedToConnecting++;
        } else if (transitioned === 'timeout') {
          result.timedOut++;
          result.transitionedToConnecting++;
        }
      }
    }

    // 2. Check connecting requests
    const connectingRequests = await this.mysqlRepo.entityRequest.findConnecting();
    result.connectingChecked = connectingRequests.length;

    if (connectingRequests.length > 0) {
      // Batch query: kiểm tra processing links cho tất cả connecting requests cùng lúc
      const connectingIds = connectingRequests.map((r) => r.id);
      const hasProcessingMap = await this.mysqlRepo.entityLink.hasProcessingLinksBatch(connectingIds);

      for (const request of connectingRequests) {
        const hasProcessing = hasProcessingMap.get(String(request.id));
        const isConnectingTimedOut = this.mysqlRepo.entityRequest.isConnectingTimedOut(request);

        // Điều kiện chuyển sang completed:
        // 1. Không còn link nào đang xử lý (connect, connecting)
        // 2. HOẶC đã quá thời gian connecting timeout (1/6 timeout gốc)
        if (!hasProcessing || isConnectingTimedOut) {
          // Nếu timeout, update các link stuck sang fail status trước
          if (isConnectingTimedOut && hasProcessing) {
            const updateResult = await this.mysqlRepo.entityLink.updateStuckLinksOnConnectingTimeout(request.id);
            const connectingTimeoutMinutes = EntityRequestRepository.calculateConnectingTimeoutMinutes(request.entity_limit);

            this.fastify.log.info(
              `Request ${request.id}: connecting timeout (${connectingTimeoutMinutes}m), updated ${updateResult.updated} stuck links to fail status`
            );
            result.connectingTimedOut++;
          }

          // Lấy link counts để log
          const linkCounts = await this.mysqlRepo.entityLink.countByStatus(request.id);

          // Chuyển trạng thái request sang completed
          await this.mysqlRepo.entityRequest.updateStatus(request.id, 'completed');

          this.fastify.log.info(
            `Request ${request.id}: connecting → completed (finish: ${linkCounts.finish}/${request.entity_limit}, ` +
            `fail connecting: ${linkCounts['fail connecting']}, fail registering: ${linkCounts['fail registering']}, ` +
            `fail profiling: ${linkCounts['fail profiling']})`
          );
          result.transitionedToCompleted++;
        }
      }
    }

    return result;
  }

  /**
   * Kiểm tra request đang running với link counts đã được batch query trước
   * @returns 'connecting' | 'timeout' | null
   */
  private async checkRunningRequestWithCounts(
    request: EntityRequest,
    linkCounts: LinkStatusCount
  ): Promise<'connecting' | 'timeout' | null> {
    const requestId = request.id;
    const entityLimit = request.entity_limit;
    const threshold = Math.ceil(entityLimit * 1.1); // 110%

    // Check 1: Số link finish >= 110% entity_limit
    if (linkCounts.finish >= threshold) {
      // Chuyển trạng thái request
      await this.mysqlRepo.entityRequest.updateStatus(requestId, 'connecting');

      // Cancel các link new
      await this.mysqlRepo.entityLink.updateStatusBulk(requestId, 'new', 'cancel');

      this.fastify.log.info(
        `Request ${requestId}: running → connecting (finish: ${linkCounts.finish}/${entityLimit})`
      );

      return 'connecting';
    }

    // Check 2: Quá timeout
    if (this.mysqlRepo.entityRequest.isRequestTimedOut(request)) {
      const timeoutMinutes = EntityRequestRepository.calculateTimeoutMinutes(entityLimit);

      // Chuyển trạng thái request
      await this.mysqlRepo.entityRequest.updateStatus(requestId, 'connecting');

      // new -> cancel, finish -> connect (đã tối ưu thành 1 query với CASE WHEN)
      await this.mysqlRepo.entityLink.updateMultipleStatusBulk(requestId, [
        { from: 'new', to: 'cancel' },
        { from: 'finish', to: 'connect' },
      ]);

      this.fastify.log.info(
        `Request ${requestId}: running → connecting (timeout ${timeoutMinutes}m, finish: ${linkCounts.finish}/${entityLimit})`
      );

      return 'timeout';
    }

    return null;
  }

  /**
   * Lấy thống kê timeout cho logging
   */
  getTimeoutInfo(entityLimit: number): { minutes: number; description: string } {
    const minutes = EntityRequestRepository.calculateTimeoutMinutes(entityLimit);
    return {
      minutes,
      description: `entity_limit=${entityLimit} -> timeout=${minutes} minutes`,
    };
  }
}
