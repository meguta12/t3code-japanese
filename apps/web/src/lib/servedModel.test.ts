import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveServedModel } from "./servedModel";

function makeActivity(
  id: string,
  turnId: string,
  payload: unknown,
  kind = "turn.model-reported",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make(turnId),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("deriveServedModel", () => {
  it("returns the reported model and effort for the given turn", () => {
    expect(
      deriveServedModel(
        [makeActivity("a1", "turn-1", { model: "gpt-5.5", effort: "high" })],
        TurnId.make("turn-1"),
      ),
    ).toEqual({ model: "gpt-5.5", effort: "high" });
  });

  it("lets a later report (reroute) override the turn's starting model", () => {
    expect(
      deriveServedModel(
        [
          makeActivity("a1", "turn-1", { model: "gpt-5.5", effort: "high" }),
          makeActivity("a2", "turn-1", { model: "gpt-5.4", reroutedFrom: "gpt-5.5" }),
        ],
        TurnId.make("turn-1"),
      ),
    ).toEqual({ model: "gpt-5.4", effort: null });
  });

  it("ignores other turns, other kinds, malformed payloads, and a missing turn", () => {
    const activities = [
      makeActivity("a1", "turn-1", { model: "old-model" }),
      makeActivity("a2", "turn-2", { model: "x" }, "context-window.updated"),
      makeActivity("a3", "turn-2", { model: "" }),
      makeActivity("a4", "turn-2", null),
    ];
    expect(deriveServedModel(activities, TurnId.make("turn-2"))).toBeNull();
    expect(deriveServedModel(activities, null)).toBeNull();
  });
});
