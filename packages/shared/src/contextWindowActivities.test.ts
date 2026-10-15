import { describe, expect, it } from "vite-plus/test";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { pruneContextWindowActivities } from "./contextWindowActivities.ts";

function usage(id: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind: "context-window.updated",
    tone: "info",
    summary: "Usage",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-10-11T00:00:00.000Z",
  };
}

describe("pruneContextWindowActivities", () => {
  it("bounds independent context and total measurements without losing either", () => {
    const activities = Array.from({ length: 1000 }, (_, index) =>
      usage(
        `activity-${index}`,
        index % 2 === 0 ? { usedTokens: index } : { totalProcessedTokens: index },
      ),
    );
    expect(pruneContextWindowActivities(activities).map((activity) => activity.id)).toEqual([
      "activity-998",
      "activity-999",
    ]);
  });

  it("keeps measurements from distinct provider sessions and malformed rows", () => {
    const activities = [
      usage("first", { provider: "claudeAgent", providerSessionId: "session-1", usedTokens: 1 }),
      usage("second", { provider: "antigravity", providerSessionId: "session-2", usedTokens: 2 }),
      usage("malformed", {}),
    ];
    expect(pruneContextWindowActivities(activities)).toBe(activities);
  });
});
