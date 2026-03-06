export function calculateSupplementDeficit(
  completionTarget: number,
  completedLinks: number
): number {
  return completionTarget - completedLinks;
}
