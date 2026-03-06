import { AllocationItemStatus, RequestStatus } from '@prisma/client';
import { isCompletedForMetrics } from '../allocation-rules';

export interface CompleteTaskDecisionInput {
  resultSuccess: boolean;
  hasLinkProfile: boolean;
  requestStatus?: RequestStatus;
  entityConnect?: string;
}

export interface CompleteTaskDecision {
  newStatus: AllocationItemStatus;
  isCompletedForMetrics: boolean;
}

export function decideCompleteTaskStatus(
  input: CompleteTaskDecisionInput
): CompleteTaskDecision {
  const { resultSuccess, hasLinkProfile, requestStatus, entityConnect = 'disable' } = input;

  let newStatus: AllocationItemStatus;
  if (!resultSuccess) {
    newStatus = AllocationItemStatus.FAILED;
  } else if (!hasLinkProfile) {
    newStatus = AllocationItemStatus.FAILED;
  } else {
    const requestIsActive =
      requestStatus === RequestStatus.PENDING ||
      requestStatus === RequestStatus.RUNNING ||
      requestStatus === RequestStatus.COMPLETED;

    if (!requestIsActive || entityConnect === 'disable') {
      newStatus = AllocationItemStatus.FINISH;
    } else if (entityConnect === 'custom') {
      newStatus = AllocationItemStatus.CONNECTING;
    } else {
      newStatus = AllocationItemStatus.CONNECT;
    }
  }

  return {
    newStatus,
    isCompletedForMetrics: isCompletedForMetrics(newStatus, hasLinkProfile),
  };
}
