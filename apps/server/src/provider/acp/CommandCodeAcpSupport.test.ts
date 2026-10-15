import { describe, expect, it } from "@effect/vitest";

import { resolveCommandCodeModeId, resolveCommandCodeModelValue } from "./CommandCodeAcpSupport.ts";

const modeState = {
  currentModeId: "default",
  availableModes: ["default", "auto-accept", "plan", "dont-ask", "bypass"].map((id) => ({
    id,
    name: id,
  })),
};

describe("resolveCommandCodeModeId", () => {
  it("maps runtime modes onto Command Code permission modes", () => {
    const resolve = (runtimeMode: Parameters<typeof resolveCommandCodeModeId>[0]["runtimeMode"]) =>
      resolveCommandCodeModeId({ runtimeMode, modeState });
    expect(resolve("approval-required")).toBe("default");
    expect(resolve("auto-accept-edits")).toBe("auto-accept");
    expect(resolve("auto")).toBe("dont-ask");
    expect(resolve("full-access")).toBe("bypass");
  });

  it("lets plan interaction win over the runtime mode", () => {
    expect(
      resolveCommandCodeModeId({
        runtimeMode: "full-access",
        interactionMode: "plan",
        modeState,
      }),
    ).toBe("plan");
  });

  it("returns nothing when the agent does not offer the mode", () => {
    expect(
      resolveCommandCodeModeId({
        runtimeMode: "full-access",
        modeState: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Standard" }],
        },
      }),
    ).toBeUndefined();
  });
});

describe("resolveCommandCodeModelValue", () => {
  const available = [
    "moonshotai/Kimi-K3",
    "claude-haiku-4-5-20251001",
    "z-ai/glm-5.3-flashx",
    "zai-org/GLM-5.3",
  ];

  it("resolves the CLI's lowercase ids and dated variants to the agent's ids", () => {
    expect(resolveCommandCodeModelValue("moonshotai/kimi-k3", available)).toBe(
      "moonshotai/Kimi-K3",
    );
    expect(resolveCommandCodeModelValue("claude-haiku-4-5", available)).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(resolveCommandCodeModelValue("kimi-k3", available)).toBe("moonshotai/Kimi-K3");
    expect(resolveCommandCodeModelValue("z-ai/glm-5.3-flashx", available)).toBe(
      "z-ai/glm-5.3-flashx",
    );
  });

  it("passes unknown slugs through so the agent can report them", () => {
    expect(resolveCommandCodeModelValue("vendor/unknown", available)).toBe("vendor/unknown");
    expect(resolveCommandCodeModelValue("  ", available)).toBeUndefined();
  });
});
