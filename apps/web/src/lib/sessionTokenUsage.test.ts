import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { deriveLatestContextWindowSnapshot } from "./contextWindow";
import { deriveSessionTokenUsage, formatSessionTokens } from "./sessionTokenUsage";

function snapshot(payload: unknown) {
  const activity: OrchestrationThreadActivity = {
    id: EventId.make("usage-test"),
    kind: "context-window.updated",
    tone: "info",
    summary: "Context window updated",
    payload,
    turnId: null,
    createdAt: "2026-10-03T00:00:00.000Z",
  };
  return deriveLatestContextWindowSnapshot([activity]);
}

describe("session token usage", () => {
  it("shows reduced current context after compaction while keeping processed totals", () => {
    const before = snapshot({ usedTokens: 180_000, totalProcessedTokens: 740_000 });
    const after = snapshot({ usedTokens: 12_000, totalProcessedTokens: 741_000 });
    expect(deriveSessionTokenUsage(before).contextTokens).toBe(180_000);
    expect(deriveSessionTokenUsage(after).contextTokens).toBe(12_000);
    expect(deriveSessionTokenUsage(after).totalTokens).toBe(741_000);
  });
  it("keeps processed totals distinct from context and subset counters", () => {
    const result = deriveSessionTokenUsage(
      snapshot({
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        lastUsedTokens: 120,
        lastInputTokens: 100,
        lastCachedInputTokens: 80,
        lastOutputTokens: 20,
        lastReasoningOutputTokens: 12,
      }),
    );
    expect(result).toEqual({
      totalTokens: 748_126,
      contextTokens: 81_659,
      lastTokens: 120,
      inputTokens: 100,
      cachedTokens: 80,
      outputTokens: 20,
      reasoningTokens: 12,
    });
  });

  it("does not invent a session total from context or one model request", () => {
    const result = deriveSessionTokenUsage(
      snapshot({
        usedTokens: 20_000,
        inputTokens: 100,
        outputTokens: 20,
      }),
    );
    expect(result.totalTokens).toBeNull();
    expect(result.lastTokens).toBe(120);
  });

  it("preserves reported zeros while marking unavailable usage", () => {
    expect(
      deriveSessionTokenUsage(snapshot({ usedTokens: 0, totalProcessedTokens: 0 })).totalTokens,
    ).toBe(0);
    expect(deriveSessionTokenUsage(null).totalTokens).toBeNull();
    expect(formatSessionTokens(0)).toBe("0");
    expect(formatSessionTokens(null)).toBe("未取得");
  });

  it("rejects invalid counters rather than showing negative or infinite usage", () => {
    const result = deriveSessionTokenUsage(
      snapshot({
        usedTokens: 1,
        totalProcessedTokens: -1,
        inputTokens: Number.NaN,
        outputTokens: Number.POSITIVE_INFINITY,
        lastUsedTokens: -1,
      }),
    );
    expect(result.totalTokens).toBeNull();
    expect(result.lastTokens).toBeNull();
  });

  it("does not mistake partial breakdowns for the whole request", () => {
    const result = deriveSessionTokenUsage(snapshot({ usedTokens: 500, inputTokens: 400 }));
    expect(result.lastTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
  });

  it("formats an exact detail count and a compact Japanese count", () => {
    expect(formatSessionTokens(748_126)).toBe("748,126");
    expect(formatSessionTokens(748_126, true)).toBe("74.8万");
    expect(formatSessionTokens(9_999, true)).toBe("9,999");
    expect(formatSessionTokens(10_000, true)).toBe("1万");
  });
});
