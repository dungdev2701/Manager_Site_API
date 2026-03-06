# Allocation Modules

## Purpose
This folder contains allocation sub-modules extracted from
`service-request-allocation.service.ts` to keep business rules and metrics writes
consistent across all allocation flows.

## Modules
- `allocation-rules.ts`: shared rule helpers for success/failure, count-once, and terminal statuses.
- `allocation-metrics.service.ts`: unified write-path for `daily_allocations` and request counters.
- `commands/complete-task.command.ts`: decision logic for complete task status transition.
- `commands/timeout-requests.command.ts`: timeout calculation helper.
- `commands/supplement-requests.command.ts`: deficit calculation helper.
- `commands/release-expired-claims.command.ts`: retry limit helper.

## Contract
- Success is counted when `linkProfile` exists.
- A task result is counted once using `completedAt`.
- `NEW -> CANCEL` business cancel decrements `allocationCount`, does not increment `failureCount`.
- Recycle opens a new allocation attempt and increments `allocationCount`.
