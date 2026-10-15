import type { ContextWindowSnapshot } from "./contextWindow";

function tokenCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

export function deriveSessionTokenUsage(usage: ContextWindowSnapshot | null) {
  const inputTokens = tokenCount(usage?.lastInputTokens ?? usage?.inputTokens);
  const outputTokens = tokenCount(usage?.lastOutputTokens ?? usage?.outputTokens);
  return {
    totalTokens: tokenCount(usage?.totalProcessedTokens),
    lastTokens:
      tokenCount(usage?.lastUsedTokens) ??
      (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    inputTokens,
    outputTokens,
    cachedTokens: tokenCount(usage?.lastCachedInputTokens ?? usage?.cachedInputTokens),
    reasoningTokens: tokenCount(usage?.lastReasoningOutputTokens ?? usage?.reasoningOutputTokens),
    contextTokens: tokenCount(usage?.usedTokens),
  };
}

export function formatSessionTokens(value: number | null, compact = false): string {
  if (value === null) return "未取得";
  if (compact && value >= 10_000) {
    return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(value / 10_000)}万`;
  }
  return new Intl.NumberFormat("ja-JP").format(value);
}
