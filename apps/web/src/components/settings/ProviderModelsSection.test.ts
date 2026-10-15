import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  describeModelCapabilities,
  groupModelsForDisplay,
  nextHiddenModelsForBulkToggle,
} from "./ProviderModelsSection";

function model(slug: string, isCustom = false): ServerProviderModel {
  return { slug, name: slug, isCustom, capabilities: null };
}

describe("describeModelCapabilities", () => {
  it("translates each fixed capability before joining without changing model data", () => {
    const capableModel: ServerProviderModel = {
      ...model("Done"),
      capabilities: {
        optionDescriptors: [
          { id: "fastMode", label: "Fast Mode", type: "boolean" },
          { id: "thinking", label: "Thinking", type: "boolean" },
          { id: "reasoningEffort", label: "Reasoning", type: "select", options: [] },
        ],
      },
    };

    expect(describeModelCapabilities(capableModel).join(" · ")).toBe(
      "高速モード · 思考中 · 推論の深さ",
    );
    expect(capableModel.slug).toBe("Done");
    expect(capableModel.capabilities?.optionDescriptors?.[0]?.label).toBe("Fast Mode");
  });
});

describe("groupModelsForDisplay", () => {
  it("lists favorites first, then visible models in user order, then hidden ones", () => {
    const models = [model("a"), model("b"), model("c"), model("d"), model("custom", true)];

    const display = groupModelsForDisplay(models, {
      favoriteModels: new Set(["c"]),
      hiddenModels: new Set(["a", "custom"]),
      modelOrder: ["d", "b"],
    });

    // A custom model is never hidden, even if its slug is in the hidden set.
    expect(display.map((entry) => entry.slug)).toEqual(["c", "d", "b", "custom", "a"]);
  });
});

describe("nextHiddenModelsForBulkToggle", () => {
  it("hides every built-in model without hiding custom models", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a"])).toEqual(["a", "b"]);
  });

  it("shows every built-in model while preserving unrelated hidden entries", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a", "b", "legacy", "custom"])).toEqual([
      "legacy",
      "custom",
    ]);
  });
});
