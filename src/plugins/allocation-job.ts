import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AllocationService } from '../services/allocation.service';
import { RequestStatusCheckerService } from '../services/request-status-checker.service';
import { ReallocationService } from '../services/reallocation.service';

// Interval in milliseconds - OPTIMIZED để giảm CPU usage
// Tăng interval để giảm số lượng queries đến DB
// Trước: 10s, 15s, 20s, 30s -> Sau: 30s, 45s, 60s, 90s
const PROCESS_INTERVAL = 30 * 1000; // Process every 30 seconds (was 10s)
const SYNC_INTERVAL = 90 * 1000; // Sync every 90 seconds (was 30s)
const STATUS_CHECK_INTERVAL = 45 * 1000; // Check status every 45 seconds (was 15s)
const REALLOCATION_INTERVAL = 60 * 1000; // Check reallocation every 60 seconds (was 20s)

const allocationJobPlugin: FastifyPluginAsync = async (fastify) => {
  // Skip if allocation job is disabled via environment variable
  // Set ALLOCATION_JOB_ENABLED=false to disable
  const isEnabled = process.env.ALLOCATION_JOB_ENABLED !== 'false';
  if (!isEnabled) {
    fastify.log.warn('⚠️ Allocation job disabled via ALLOCATION_JOB_ENABLED=false');
    return;
  }

  // Skip if MySQL is not configured
  if (!fastify.mysql) {
    fastify.log.warn('⚠️ MySQL not configured, allocation job disabled');
    return;
  }

  let processIntervalId: NodeJS.Timeout | null = null;
  let syncIntervalId: NodeJS.Timeout | null = null;
  let statusCheckIntervalId: NodeJS.Timeout | null = null;
  let reallocationIntervalId: NodeJS.Timeout | null = null;
  let isProcessing = false;
  let isSyncing = false;
  let isCheckingStatus = false;
  let isReallocating = false;

  const allocationService = new AllocationService(fastify);
  const statusChecker = new RequestStatusCheckerService(fastify);
  const reallocationService = new ReallocationService(fastify);

  /**
   * Process pending requests
   * Runs every 10 seconds
   */
  const runProcessJob = async () => {
    // Prevent overlapping runs
    if (isProcessing) {
      return;
    }

    isProcessing = true;
    try {
      await allocationService.processPendingRequests();
      // Log is handled inside processPendingRequests
    } catch (error) {
      fastify.log.error({ err: error }, '[Allocation Job] Error processing requests');
    } finally {
      isProcessing = false;
    }
  };

  /**
   * Sync completed requests
   * Runs every 30 seconds
   */
  const runSyncJob = async () => {
    // Prevent overlapping runs
    if (isSyncing) {
      return;
    }

    isSyncing = true;
    try {
      await allocationService.syncCompletedRequests();
      // Log is handled inside syncCompletedRequests
    } catch (error) {
      fastify.log.error({ err: error }, '[Sync Job] Error syncing results');
    } finally {
      isSyncing = false;
    }
  };

  /**
   * Check and update request status
   * - Running requests: check finish count >= 110% or timeout
   * - Connecting requests: check no processing links -> completed
   * Runs every 15 seconds
   */
  const runStatusCheckJob = async () => {
    // Prevent overlapping runs
    if (isCheckingStatus) {
      return;
    }

    isCheckingStatus = true;
    try {
      await statusChecker.checkAll();
      // Log is handled inside statusChecker for each transition
    } catch (error) {
      fastify.log.error({ err: error }, '[Status Check] Error checking request status');
    } finally {
      isCheckingStatus = false;
    }
  };

  /**
   * Check and reallocate for running requests
   * - If no processing links and finish < 110% and not timed out
   * - Allocate more websites or retry failed links
   * Runs every 20 seconds
   */
  const runReallocationJob = async () => {
    // Prevent overlapping runs
    if (isReallocating) {
      return;
    }

    isReallocating = true;
    try {
      await reallocationService.checkAndReallocate();
      // Log is handled inside reallocationService
    } catch (error) {
      fastify.log.error({ err: error }, '[Reallocation Job] Error checking reallocation');
    } finally {
      isReallocating = false;
    }
  };

  // Start jobs when server is ready
  fastify.addHook('onReady', async () => {
    fastify.log.info('🚀 Starting allocation middleware jobs...');

    // Run immediately on startup
    await runProcessJob();
    await runSyncJob();
    await runStatusCheckJob();
    await runReallocationJob();

    // Then run on intervals
    processIntervalId = setInterval(runProcessJob, PROCESS_INTERVAL);
    syncIntervalId = setInterval(runSyncJob, SYNC_INTERVAL);
    statusCheckIntervalId = setInterval(runStatusCheckJob, STATUS_CHECK_INTERVAL);
    reallocationIntervalId = setInterval(runReallocationJob, REALLOCATION_INTERVAL);

    fastify.log.info(
      `✅ Allocation job started (process: ${PROCESS_INTERVAL / 1000}s, sync: ${SYNC_INTERVAL / 1000}s, status: ${STATUS_CHECK_INTERVAL / 1000}s, realloc: ${REALLOCATION_INTERVAL / 1000}s)`
    );
  });

  // Stop jobs on shutdown
  fastify.addHook('onClose', async () => {
    if (processIntervalId) {
      clearInterval(processIntervalId);
      processIntervalId = null;
    }
    if (syncIntervalId) {
      clearInterval(syncIntervalId);
      syncIntervalId = null;
    }
    if (statusCheckIntervalId) {
      clearInterval(statusCheckIntervalId);
      statusCheckIntervalId = null;
    }
    if (reallocationIntervalId) {
      clearInterval(reallocationIntervalId);
      reallocationIntervalId = null;
    }
    fastify.log.info('Allocation jobs stopped');
  });
};

export default fp(allocationJobPlugin, {
  name: 'allocation-job',
  dependencies: ['prisma', 'mysql'],
});
