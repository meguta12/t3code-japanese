import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveLatestContextWindowSnapshot, formatContextWindowTokens } from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("keeps the last reported total when the newest usage event has none", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 300_000,
        totalProcessedTokens: 900_000,
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 459_821,
        maxTokens: 1_000_000,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(459_821);
    expect(snapshot?.totalProcessedTokens).toBe(900_000);
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it.each([
    { provider: "antigravity", providerInstanceId: "claude", providerSessionId: "session-1" },
    { provider: "claudeAgent", providerInstanceId: "other-claude", providerSessionId: "session-1" },
    { provider: "claudeAgent", providerInstanceId: "claude", providerSessionId: "session-2" },
  ])("does not carry usage across provider/session boundaries: %j", (nextOrigin) => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("old", "context-window.updated", {
        provider: "claudeAgent",
        providerInstanceId: "claude",
        providerSessionId: "session-1",
        usedTokens: 100,
        totalProcessedTokens: 900,
      }),
      makeActivity("new", "context-window.updated", { ...nextOrigin, usedTokens: 20 }),
    ]);
    expect(snapshot?.totalProcessedTokens).toBeNull();
  });

  it("hides old usage immediately when the active provider changes before it reports usage", () => {
    const activities = [
      makeActivity("old", "context-window.updated", {
        provider: "claudeAgent",
        providerInstanceId: "claude",
        usedTokens: 100,
        totalProcessedTokens: 900,
      }),
    ];
    expect(
      deriveLatestContextWindowSnapshot(activities, {
        provider: "antigravity",
        providerInstanceId: "antigravity",
      }),
    ).toBeNull();
    expect(
      deriveLatestContextWindowSnapshot(activities, {
        provider: "claudeAgent",
        providerInstanceId: "claude",
      })?.totalProcessedTokens,
    ).toBe(900);
  });

  it("reports totals without inventing current context usage", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("total", "context-window.updated", { totalProcessedTokens: 5000 }),
    ]);
    expect(snapshot).toMatchObject({
      totalProcessedTokens: 5000,
      usedTokens: null,
      maxTokens: null,
      remainingTokens: null,
      usedPercentage: null,
    });
  });

  it("keeps a real context snapshot when the same session later reports turn totals", () => {
    const origin = { provider: "antigravity", providerSessionId: "session-1" };
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("context", "context-window.updated", {
        ...origin,
        usedTokens: 100,
        maxTokens: 200,
      }),
      makeActivity("total", "context-window.updated", { ...origin, totalProcessedTokens: 5000 }),
    ]);
    expect(snapshot).toMatchObject({
      usedTokens: 100,
      usedPercentage: 50,
      totalProcessedTokens: 5000,
    });
  });
});
