import { AllocationItemStatus } from '@prisma/client';

export const TERMINAL_STATUSES: AllocationItemStatus[] = [
  AllocationItemStatus.FINISH,
  AllocationItemStatus.FAILED,
  AllocationItemStatus.CANCEL,
  AllocationItemStatus.FAIL_REGISTERING,
  AllocationItemStatus.FAIL_PROFILING,
  AllocationItemStatus.FAIL_CONNECTING,
];

export function isSuccessByProfile(linkProfile?: string | null): boolean {
  return Boolean(linkProfile);
}

export function shouldCountOnce(completedAt?: Date | null): boolean {
  return !completedAt;
}

export function isBusinessCancelFromNew(
  prevStatus: AllocationItemStatus,
  nextStatus: AllocationItemStatus,
  errorCode?: string | null
): boolean {
  if (prevStatus !== AllocationItemStatus.NEW || nextStatus !== AllocationItemStatus.CANCEL) {
    return false;
  }
  return errorCode !== 'REQUEST_TIMEOUT';
}

export function isCompletedForMetrics(
  status: AllocationItemStatus,
  hasLinkProfile: boolean
): boolean {
  return (
    status === AllocationItemStatus.FINISH ||
    status === AllocationItemStatus.FAILED ||
    (status === AllocationItemStatus.CONNECTING && hasLinkProfile) ||
    (status === AllocationItemStatus.CONNECT && hasLinkProfile)
  );
}
