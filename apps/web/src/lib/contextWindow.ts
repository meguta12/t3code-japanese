import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sameUsageSession(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): boolean {
  return ["provider", "providerInstanceId", "providerSessionId"].every(
    (key) => left?.[key] === right?.[key],
  );
}

type NullableContextWindowUsage = {
  readonly [
    Key in keyof ThreadTokenUsageSnapshot
  ]-?: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/**
 * Claude only attaches a cumulative total to some of its usage events (the rest
 * are mid-turn snapshots), so the newest event often has none. Show the most
 * recent total that was reported instead of dropping to "unknown".
 */
function findEarlierTotalProcessedTokens(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  beforeIndex: number,
): number | null {
  const currentPayload = asRecord(activities[beforeIndex]?.payload);
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (!sameUsageSession(currentPayload, payload)) break;
    const total = asFiniteNumber(payload?.totalProcessedTokens);
    if (total !== null && total >= 0) {
      return total;
    }
  }
  return null;
}

function findEarlierContextUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  beforeIndex: number,
): Record<string, unknown> | null {
  const currentPayload = asRecord(activities[beforeIndex]?.payload);
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "context-window.updated") continue;
    const payload = asRecord(activity.payload);
    if (!sameUsageSession(currentPayload, payload)) break;
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens !== null && usedTokens >= 0) return payload;
  }
  return null;
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  currentProvider?: {
    readonly provider: string | null;
    readonly providerInstanceId?: string | undefined;
  },
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    if (
      currentProvider?.provider &&
      (payload?.provider !== currentProvider.provider ||
        (currentProvider.providerInstanceId !== undefined &&
          payload?.providerInstanceId !== currentProvider.providerInstanceId))
    ) {
      return null;
    }
    const reportedUsedTokens = asFiniteNumber(payload?.usedTokens);
    const reportedTotal = asFiniteNumber(payload?.totalProcessedTokens);
    if (
      (reportedUsedTokens === null || reportedUsedTokens < 0) &&
      (reportedTotal === null || reportedTotal < 0)
    ) {
      continue;
    }

    const contextPayload =
      reportedUsedTokens !== null && reportedUsedTokens >= 0
        ? payload
        : findEarlierContextUsage(activities, index);
    const usedTokens = asFiniteNumber(contextPayload?.usedTokens);

    const maxTokens = asFiniteNumber(contextPayload?.maxTokens);
    const usedPercentage =
      usedTokens !== null && maxTokens !== null && maxTokens > 0
        ? Math.min(100, (usedTokens / maxTokens) * 100)
        : null;
    const remainingTokens =
      usedTokens !== null && maxTokens !== null
        ? Math.max(0, Math.round(maxTokens - usedTokens))
        : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: reportedTotal ?? findEarlierTotalProcessedTokens(activities, index),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      autoCompactThreshold: asFiniteNumber(payload?.autoCompactThreshold),
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
