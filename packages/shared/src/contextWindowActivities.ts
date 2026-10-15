import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/** Current context and processed totals can arrive independently in one turn. */
export function contextWindowActivityKeys(activity: OrchestrationThreadActivity): string[] {
  if (activity.kind !== "context-window.updated") return [];
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return ["usedTokens", "totalProcessedTokens"].flatMap((counter) => {
    const value = payload?.[counter];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? [
          JSON.stringify([
            activity.turnId,
            payload?.provider ?? null,
            payload?.providerInstanceId ?? null,
            payload?.providerSessionId ?? null,
            counter,
          ]),
        ]
      : [];
  });
}

/** Retains the newest row for each measurement per turn and provider session. */
export function pruneContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const seen = new Set<string>();
  const keep = new Set<number>();
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const keys = contextWindowActivityKeys(activities[index]!);
    if (keys.length === 0 || keys.some((key) => !seen.has(key))) keep.add(index);
    for (const key of keys) seen.add(key);
  }
  return keep.size === activities.length
    ? activities
    : activities.filter((_, index) => keep.has(index));
}
