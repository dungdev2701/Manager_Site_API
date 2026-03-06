export function calculateRequestTimeoutMinutes(
  entityLimit: number,
  completionTimePer100: number,
  smallRequestTimeoutMinutes: number
): number {
  if (entityLimit < 100) {
    return smallRequestTimeoutMinutes;
  }
  return Math.ceil((entityLimit / 100) * completionTimePer100);
}
