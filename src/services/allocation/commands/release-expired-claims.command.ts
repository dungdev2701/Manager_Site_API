export function hasExceededRetryLimit(
  retryIndex: number,
  maxRetries: number
): boolean {
  return retryIndex >= maxRetries;
}
