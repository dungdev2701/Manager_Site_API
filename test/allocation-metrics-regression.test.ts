import test from 'node:test';
import assert from 'node:assert/strict';
import { AllocationItemStatus } from '@prisma/client';
import {
  isBusinessCancelFromNew,
  isCompletedForMetrics,
  isSuccessByProfile,
  shouldCountOnce,
} from '../src/services/allocation/allocation-rules';
import { AllocationMetricsService } from '../src/services/allocation/allocation-metrics.service';

function createFakeDb() {
  const calls = {
    executeRaw: [] as string[],
    serviceRequestUpdate: [] as Array<{ id: string; data: unknown }>,
    dailyUpsert: [] as Array<unknown>,
  };

  const db = {
    $executeRaw: async (...args: unknown[]) => {
      calls.executeRaw.push(String(args[0] ?? ''));
      return 1;
    },
    serviceRequest: {
      update: async (input: { where: { id: string }; data: unknown }) => {
        calls.serviceRequestUpdate.push({ id: input.where.id, data: input.data });
        return {};
      },
    },
    dailyAllocation: {
      upsert: async (input: unknown) => {
        calls.dailyUpsert.push(input);
        return {};
      },
    },
  };

  return { db, calls };
}

test('1) normal success: task with linkProfile is counted as success', async () => {
  assert.equal(isSuccessByProfile('https://profile'), true);
  assert.equal(
    isCompletedForMetrics(AllocationItemStatus.FINISH, true),
    true
  );
});

test('2) fail: task without linkProfile is counted as failure', async () => {
  assert.equal(isSuccessByProfile(null), false);
  assert.equal(
    isCompletedForMetrics(AllocationItemStatus.FAILED, false),
    true
  );
});

test('3) timeout processing vs NEW cancel: timeout is not business cancel', async () => {
  assert.equal(
    isBusinessCancelFromNew(
      AllocationItemStatus.NEW,
      AllocationItemStatus.CANCEL,
      'REQUEST_TIMEOUT'
    ),
    false
  );
});

test('4) target reached NEW->CANCEL: decrement allocation, no failure increment', async () => {
  const { db, calls } = createFakeDb();
  const service = new AllocationMetricsService();

  await service.recordTerminalResult(db as never, {
    requestId: 'req-1',
    websiteId: 'web-1',
    allocatedAt: new Date('2026-03-05T00:00:00.000Z'),
    prevStatus: AllocationItemStatus.NEW,
    nextStatus: AllocationItemStatus.CANCEL,
    errorCode: 'TARGET_REACHED',
    isSuccess: false,
  });

  assert.equal(calls.serviceRequestUpdate.length, 1);
  assert.equal(calls.dailyUpsert.length, 0);
  assert.ok(calls.executeRaw.length >= 1);
});

test('5) recycle new attempt: allocationCount +1 write path is called', async () => {
  const { db, calls } = createFakeDb();
  const service = new AllocationMetricsService();

  await service.incrementAttempts(
    db as never,
    ['web-1', 'web-2'],
    new Date('2026-03-05T00:00:00.000Z')
  );

  assert.equal(calls.executeRaw.length, 1);
});

test('6) double-count guard: completedAt already set must not be counted again', async () => {
  assert.equal(shouldCountOnce(new Date('2026-03-05T00:00:00.000Z')), false);
  assert.equal(shouldCountOnce(null), true);
});
