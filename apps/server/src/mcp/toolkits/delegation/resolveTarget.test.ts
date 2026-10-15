import { ProviderInstanceId, type DelegationPreset } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveDelegationTarget,
  type CatalogModel,
  type CatalogProvider,
  type DelegationTargetInput,
} from "./resolveTarget.ts";

const effortDescriptor = (id: string, values: ReadonlyArray<readonly [string, string]>) =>
  ({
    id,
    label: "Reasoning",
    type: "select" as const,
    options: values.map(([value, label]) => ({ id: value, label })),
  }) as const;

const model = (
  slug: string,
  name: string,
  overrides: Partial<CatalogModel> = {},
): CatalogModel => ({
  slug,
  name,
  aliases: [],
  isDefault: false,
  optionDescriptors: [],
  ...overrides,
});

const provider = (
  instanceId: string,
  driver: string,
  displayName: string,
  models: ReadonlyArray<CatalogModel>,
  overrides: Partial<CatalogProvider> = {},
): CatalogProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver,
  displayName,
  ready: true,
  models,
  ...overrides,
});

const codexEfforts = effortDescriptor("reasoningEffort", [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
  ["ultra", "Ultra"],
]);

const catalog = [
  provider("codex", "codex", "Codex", [
    model("gpt-6.1-sol", "GPT-6.1-Sol", {
      aliases: ["sol"],
      optionDescriptors: [codexEfforts],
    }),
    model("gpt-6-astra", "GPT-6 Astra", { isDefault: true, optionDescriptors: [codexEfforts] }),
    model("gpt-6-luna", "GPT-6 Luna"),
  ]),
  provider("claudeAgent", "claudeAgent", "Claude", [
    model("claude-fable-5-1", "Claude Fable 5.1", {
      isDefault: true,
      optionDescriptors: [
        effortDescriptor("effort", [
          ["low", "Low"],
          ["high", "High"],
          ["xhigh", "Extra High"],
          ["max", "Max"],
          ["ultracode", "Ultracode"],
        ]),
      ],
    }),
  ]),
];

const presets: ReadonlyArray<DelegationPreset> = [
  {
    id: "impl",
    name: "実装役",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "ultra" }],
    },
  },
  {
    id: "ghost",
    name: "幽霊",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-9" },
  },
];

const resolve = (request: DelegationTargetInput, withCatalog = catalog) =>
  resolveDelegationTarget({ catalog: withCatalog, presets, request });

const okTarget = (request: DelegationTargetInput, withCatalog = catalog) => {
  const result = resolve(request, withCatalog);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.target;
};

const errorOf = (request: DelegationTargetInput, withCatalog = catalog) => {
  const result = resolve(request, withCatalog);
  if (result.ok) throw new Error("expected a rejection");
  return result.error;
};

describe("resolveDelegationTarget models", () => {
  it("matches the slug exactly", () => {
    const target = okTarget({ model: "gpt-6.1-sol" });
    expect(target.selection).toEqual({ instanceId: "codex", model: "gpt-6.1-sol" });
    expect(target.effort).toBeNull();
  });

  it.each(["GPT-6.1-Sol", "gpt 6.1 sol", "GPT_6.1_SOL", "  gpt-6.1-sol  ", "sol"])(
    "normalizes %j to the same model",
    (spelling) => {
      expect(okTarget({ model: spelling }).model).toBe("gpt-6.1-sol");
    },
  );

  it("matches a display name that differs from the slug only by punctuation", () => {
    expect(okTarget({ model: "claude fable 5.1" }).model).toBe("claude-fable-5-1");
  });

  it("narrows by provider name, driver or alias", () => {
    expect(okTarget({ provider: "Claude", model: "claude-fable-5-1" }).provider).toBe(
      "claudeAgent",
    );
    expect(okTarget({ provider: "anthropic", model: "claude fable 5.1" }).provider).toBe(
      "claudeAgent",
    );
  });

  it("uses a provider's default model when only the provider is named", () => {
    expect(okTarget({ provider: "codex" }).model).toBe("gpt-6-astra");
  });

  it("lists candidates for an unknown model and never substitutes one", () => {
    const error = errorOf({ model: "gpt-9" });
    expect(error.code).toBe("unknown_model");
    expect(error.candidates).toContain("codex / gpt-6.1-sol (GPT-6.1-Sol)");
    expect(error.candidates).toContain("claudeAgent / claude-fable-5-1 (Claude Fable 5.1)");
  });

  it("narrows candidates to near misses when some exist", () => {
    expect(errorOf({ model: "6.1" }).candidates).toEqual(["codex / gpt-6.1-sol (GPT-6.1-Sol)"]);
  });

  it("does not accept a partial model name", () => {
    expect(errorOf({ model: "gpt" }).code).toBe("unknown_model");
  });

  it("reports an unknown provider with the valid ones", () => {
    const error = errorOf({ provider: "gemini", model: "x" });
    expect(error.code).toBe("unknown_provider");
    expect(error.candidates).toEqual(["codex (Codex)", "claudeAgent (Claude)"]);
  });

  it("refuses a model that two instances both offer instead of picking one", () => {
    const twoCodex = [
      ...catalog,
      provider("codex_work", "codex", "Codex (work)", [model("gpt-6.1-sol", "GPT-6.1-Sol")]),
    ];
    const error = errorOf({ model: "gpt-6.1-sol" }, twoCodex);
    expect(error.code).toBe("ambiguous_model");
    expect(error.candidates).toEqual([
      "codex / gpt-6.1-sol (GPT-6.1-Sol)",
      "codex_work / gpt-6.1-sol (GPT-6.1-Sol)",
    ]);
    expect(okTarget({ provider: "codex_work", model: "gpt-6.1-sol" }, twoCodex).provider).toBe(
      "codex_work",
    );
  });

  it("refuses a driver name shared by two instances when no model narrows it", () => {
    const twoCodex = [
      provider("codex_a", "codex", "Codex A", []),
      provider("codex_b", "codex", "Codex B", []),
    ];
    expect(errorOf({ provider: "codex" }, twoCodex)).toMatchObject({
      code: "ambiguous_provider",
      candidates: ["codex_a (Codex A)", "codex_b (Codex B)"],
    });
  });

  it("refuses a provider that is not ready", () => {
    const offline = [
      provider("codex", "codex", "Codex", [model("gpt-6.1-sol", "GPT-6.1-Sol")], {
        ready: false,
        notReadyReason: "not signed in",
      }),
    ];
    expect(errorOf({ model: "gpt-6.1-sol" }, offline)).toMatchObject({
      code: "provider_not_ready",
      message: expect.stringContaining("not signed in"),
    });
  });

  it("asks for a target when nothing names one", () => {
    expect(errorOf({})).toMatchObject({ code: "missing_target", candidates: ["実装役", "幽霊"] });
    expect(errorOf({ effort: "high" }).code).toBe("missing_target");
  });
});

describe("resolveDelegationTarget effort", () => {
  it.each([
    ["ultra", "ultra"],
    ["Ultra", "ultra"],
    ["ウルトラ", "ultra"],
    ["extra high", "xhigh"],
    ["x-high", "xhigh"],
    ["エクストラハイ", "xhigh"],
    ["高", "high"],
    ["HIGH", "high"],
    ["ミディアム", "medium"],
  ])("maps %j to %s on Codex", (spoken, optionId) => {
    const target = okTarget({ model: "gpt-6.1-sol", effort: spoken });
    expect(target.effort).toBe(optionId);
    expect(target.selection.options).toEqual([{ id: "reasoningEffort", value: optionId }]);
  });

  it("uses the model's own descriptor id and ids exactly as offered", () => {
    const target = okTarget({ provider: "claude", model: "claude fable 5.1", effort: "ultracode" });
    expect(target.selection.options).toEqual([{ id: "effort", value: "ultracode" }]);
    expect(okTarget({ model: "claude-fable-5-1", effort: "最大" }).effort).toBe("max");
  });

  it("rejects an effort the model does not offer and lists the valid ones", () => {
    const error = errorOf({ model: "claude-fable-5-1", effort: "ultra" });
    expect(error.code).toBe("unsupported_effort");
    expect(error.candidates).toEqual([
      "low (Low)",
      "high (High)",
      "xhigh (Extra High)",
      "max (Max)",
      "ultracode (Ultracode)",
    ]);
  });

  it("rejects an effort on a model without an effort setting", () => {
    expect(errorOf({ model: "gpt-6-luna", effort: "high" })).toMatchObject({
      code: "unsupported_effort",
      candidates: [],
    });
  });

  it("applies an effort to the caller's own model when only the effort is given", () => {
    const result = resolveDelegationTarget({
      catalog,
      presets,
      request: { effort: "ultra" },
      base: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    });
    expect(result.ok && result.target.selection).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "ultra" }],
    });
  });
});

describe("resolveDelegationTarget presets", () => {
  it.each(["実装役", " 実装役 ", "impl"])("resolves the preset spelled %j", (spelling) => {
    const target = okTarget({ preset: spelling });
    expect(target).toMatchObject({
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "ultra",
      presetName: "実装役",
    });
    expect(target.selection.options).toEqual([{ id: "reasoningEffort", value: "ultra" }]);
  });

  it("wins over provider, model and effort and says which it ignored", () => {
    const target = okTarget({ preset: "実装役", model: "claude-fable-5-1", effort: "low" });
    expect(target.model).toBe("gpt-6.1-sol");
    expect(target.ignored).toEqual(["model", "effort"]);
  });

  it("lists the saved presets for an unknown name", () => {
    expect(errorOf({ preset: "設計役" })).toMatchObject({
      code: "unknown_preset",
      candidates: ["実装役", "幽霊"],
    });
  });

  it("reports a preset whose model no longer exists", () => {
    const error = errorOf({ preset: "幽霊" });
    expect(error.code).toBe("preset_unavailable");
    expect(error.candidates).toContain("codex / gpt-6.1-sol (GPT-6.1-Sol)");
  });
});
