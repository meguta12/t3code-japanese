import {
  isProviderAvailable,
  type DelegationPreset,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * Turns what an agent says ("gpt-6.1-sol", "ultra", the preset "実装役") into a
 * full model selection. Pure: the caller supplies the provider catalog.
 *
 * Matching is exact after normalizing case, width and separators. It never
 * guesses between two models and never falls back to a different one; a miss
 * or a tie is returned as a structured error that lists the valid choices.
 */

export interface CatalogModel {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string | undefined;
  readonly aliases: ReadonlyArray<string>;
  readonly isDefault: boolean;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
}

export interface CatalogProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly displayName: string;
  readonly ready: boolean;
  /** Why a provider that is not ready cannot take work; absent when ready. */
  readonly notReadyReason?: string | undefined;
  readonly models: ReadonlyArray<CatalogModel>;
}

export type DelegationTargetErrorCode =
  | "missing_target"
  | "unknown_preset"
  | "preset_unavailable"
  | "unknown_provider"
  | "ambiguous_provider"
  | "unknown_model"
  | "ambiguous_model"
  | "unsupported_effort"
  | "provider_not_ready";

export interface DelegationTargetError {
  readonly code: DelegationTargetErrorCode;
  readonly message: string;
  /** Valid choices for the argument that failed, ready to paste back. */
  readonly candidates: ReadonlyArray<string>;
}

export interface ResolvedDelegationTarget {
  readonly selection: ModelSelection;
  readonly provider: ProviderInstanceId;
  readonly providerName: string;
  readonly model: string;
  readonly modelName: string;
  /** Effort option id the child starts with; null leaves the provider default. */
  readonly effort: string | null;
  readonly presetName?: string | undefined;
  /** Arguments a preset made redundant; reported so nothing is dropped silently. */
  readonly ignored: ReadonlyArray<string>;
}

export type ResolveDelegationTargetResult =
  | { readonly ok: true; readonly target: ResolvedDelegationTarget }
  | { readonly ok: false; readonly error: DelegationTargetError };

export interface DelegationTargetInput {
  readonly preset?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

const MAX_CANDIDATES = 40;

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Drops every separator so "gpt 6.1 sol" and "gpt-6-1-sol" meet. */
const squash = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const EFFORT_SYNONYMS: Readonly<Record<string, string>> = {
  ultra: "ultra",
  ウルトラ: "ultra",
  うるとら: "ultra",
  xhigh: "xhigh",
  extrahigh: "xhigh",
  エクストラハイ: "xhigh",
  エクストラ: "xhigh",
  超高: "xhigh",
  max: "max",
  maximum: "max",
  マックス: "max",
  最大: "max",
  high: "high",
  ハイ: "high",
  高: "high",
  高い: "high",
  medium: "medium",
  med: "medium",
  mid: "medium",
  ミディアム: "medium",
  中: "medium",
  中程度: "medium",
  low: "low",
  ロー: "low",
  低: "low",
  低い: "low",
  minimal: "minimal",
  ミニマル: "minimal",
  最小: "minimal",
};

const PROVIDER_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  claudeagent: ["claude", "claudecode", "anthropic"],
  codex: ["openai", "chatgpt"],
};

const EFFORT_DESCRIPTOR_IDS: ReadonlySet<string> = new Set(["reasoningEffort", "effort"]);

const effortDescriptorOf = (model: CatalogModel) => {
  const selects = model.optionDescriptors.filter((descriptor) => descriptor.type === "select");
  return (
    selects.find((descriptor) => EFFORT_DESCRIPTOR_IDS.has(descriptor.id)) ??
    selects.find((descriptor) => /effort|reasoning/i.test(`${descriptor.id} ${descriptor.label}`))
  );
};

const describeModel = (provider: CatalogProvider, model: CatalogModel) =>
  model.name === model.slug
    ? `${provider.instanceId} / ${model.slug}`
    : `${provider.instanceId} / ${model.slug} (${model.name})`;

const capped = (lines: ReadonlyArray<string>) =>
  lines.length > MAX_CANDIDATES ? lines.slice(0, MAX_CANDIDATES) : lines;

const fail = (
  code: DelegationTargetErrorCode,
  message: string,
  candidates: ReadonlyArray<string> = [],
): ResolveDelegationTargetResult => ({
  ok: false,
  error: { code, message, candidates: capped(candidates) },
});

const providerKeys = (provider: CatalogProvider): ReadonlyArray<string> => [
  provider.instanceId,
  provider.driver,
  provider.displayName,
];

const providerCandidates = (catalog: ReadonlyArray<CatalogProvider>) =>
  catalog.map((provider) =>
    provider.displayName === provider.instanceId
      ? provider.instanceId
      : `${provider.instanceId} (${provider.displayName})`,
  );

/** Instance id first, then driver or display name, then the same ignoring separators. */
function matchProviders(
  catalog: ReadonlyArray<CatalogProvider>,
  query: string,
): ReadonlyArray<CatalogProvider> {
  const tiers: ReadonlyArray<(provider: CatalogProvider) => boolean> = [
    (provider) => provider.instanceId.toLowerCase() === query.trim().toLowerCase(),
    (provider) => providerKeys(provider).some((key) => normalize(key) === normalize(query)),
    (provider) =>
      providerKeys(provider).some((key) => squash(key) === squash(query)) ||
      (PROVIDER_ALIASES[squash(provider.driver)] ?? []).includes(squash(query)),
  ];
  for (const matches of tiers) {
    const found = catalog.filter(matches);
    if (found.length > 0) return found;
  }
  return [];
}

function matchModels(
  providers: ReadonlyArray<CatalogProvider>,
  query: string,
): ReadonlyArray<{ readonly provider: CatalogProvider; readonly model: CatalogModel }> {
  const entries = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const names = (model: CatalogModel) => [
    model.slug,
    model.name,
    ...(model.shortName ? [model.shortName] : []),
    ...model.aliases,
  ];
  const tiers: ReadonlyArray<(model: CatalogModel) => boolean> = [
    (model) => model.slug.toLowerCase() === query.trim().toLowerCase(),
    (model) => names(model).some((name) => normalize(name) === normalize(query)),
    (model) => names(model).some((name) => squash(name) === squash(query)),
  ];
  for (const matches of tiers) {
    const found = entries.filter((entry) => matches(entry.model));
    if (found.length > 0) return found;
  }
  return [];
}

function resolveEffort(model: CatalogModel, requested: string) {
  const descriptor = effortDescriptorOf(model);
  const choices =
    descriptor?.type === "select"
      ? descriptor.options.map((option) =>
          option.label === option.id ? option.id : `${option.id} (${option.label})`,
        )
      : [];
  if (descriptor?.type !== "select") {
    return {
      error: {
        code: "unsupported_effort" as const,
        message: `${model.name} has no effort setting, so "${requested}" cannot be applied. Omit effort.`,
        candidates: [],
      },
    };
  }
  const wanted = squash(requested);
  const canonical = EFFORT_SYNONYMS[wanted] ?? EFFORT_SYNONYMS[requested.trim()];
  const byText = (text: string) =>
    descriptor.options.filter(
      (option) => squash(option.id) === text || squash(option.label) === text,
    );
  const found = byText(wanted).length > 0 ? byText(wanted) : canonical ? byText(canonical) : [];
  if (found.length !== 1) {
    return {
      error: {
        code: "unsupported_effort" as const,
        message:
          found.length === 0
            ? `${model.name} does not offer effort "${requested}". Valid efforts: ${choices.join(", ")}.`
            : `Effort "${requested}" matches more than one option on ${model.name}: ${choices.join(", ")}.`,
        candidates: choices,
      },
    };
  }
  return { descriptorId: descriptor.id, optionId: found[0]!.id };
}

const effortOfSelection = (selection: ModelSelection, model: CatalogModel | undefined) => {
  const descriptorId =
    (model ? effortDescriptorOf(model)?.id : undefined) ??
    selection.options?.find((option) => EFFORT_DESCRIPTOR_IDS.has(option.id))?.id;
  const value = selection.options?.find((option) => option.id === descriptorId)?.value;
  return typeof value === "string" ? value : null;
};

function resolvePreset(
  catalog: ReadonlyArray<CatalogProvider>,
  presets: ReadonlyArray<DelegationPreset>,
  query: string,
  ignored: ReadonlyArray<string>,
): ResolveDelegationTargetResult {
  const matches = presets.filter(
    (preset) =>
      normalize(preset.name) === normalize(query) ||
      squash(preset.name) === squash(query) ||
      preset.id.toLowerCase() === query.trim().toLowerCase(),
  );
  if (matches.length !== 1) {
    const names = presets.map((preset) => preset.name);
    return fail(
      "unknown_preset",
      matches.length === 0
        ? `No delegation preset named "${query}". ${names.length > 0 ? `Saved presets: ${names.join(", ")}.` : "No presets are saved; pass provider and model instead."}`
        : `More than one preset is named "${query}". Ask the user to rename one in Settings.`,
      names,
    );
  }
  const preset = matches[0]!;
  const selection = preset.modelSelection;
  const provider = catalog.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find(
    (entry) => entry.slug.toLowerCase() === selection.model.toLowerCase(),
  );
  if (!provider || !model) {
    return fail(
      "preset_unavailable",
      `Preset "${preset.name}" points to ${selection.instanceId} / ${selection.model}, which this server does not offer. Ask the user to update the preset in Settings.`,
      provider
        ? provider.models.map((entry) => describeModel(provider, entry))
        : providerCandidates(catalog),
    );
  }
  if (!provider.ready) {
    return fail(
      "provider_not_ready",
      `Preset "${preset.name}" uses ${provider.displayName}, which is not ready: ${provider.notReadyReason ?? "not available"}.`,
    );
  }
  for (const saved of selection.options ?? []) {
    const descriptor = model.optionDescriptors.find((entry) => entry.id === saved.id);
    const supported =
      descriptor?.type === "boolean"
        ? typeof saved.value === "boolean"
        : descriptor?.type === "select" &&
          descriptor.options.some((option) => option.id === saved.value);
    if (!supported) {
      return fail(
        "preset_unavailable",
        `Preset "${preset.name}" contains an unsupported option ${saved.id}=${String(saved.value)}. Update the preset in Settings.`,
        descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
      );
    }
  }
  return {
    ok: true,
    target: {
      selection: { ...selection, model: model.slug },
      provider: provider.instanceId,
      providerName: provider.displayName,
      model: model.slug,
      modelName: model.name,
      effort: effortOfSelection(selection, model),
      presetName: preset.name,
      ignored,
    },
  };
}

export function resolveDelegationTarget(input: {
  readonly catalog: ReadonlyArray<CatalogProvider>;
  readonly presets: ReadonlyArray<DelegationPreset>;
  readonly request: DelegationTargetInput;
  /** The caller's own selection; lets "same model, ultra effort" omit provider and model. */
  readonly base?: ModelSelection | undefined;
}): ResolveDelegationTargetResult {
  const { catalog, presets, request, base } = input;
  const presetQuery = request.preset?.trim();
  const providerQuery = request.provider?.trim();
  const modelQuery = request.model?.trim();
  const effortQuery = request.effort?.trim();

  if (presetQuery) {
    const ignored = [
      ...(providerQuery ? ["provider"] : []),
      ...(modelQuery ? ["model"] : []),
      ...(effortQuery ? ["effort"] : []),
    ];
    return resolvePreset(catalog, presets, presetQuery, ignored);
  }

  let providers = catalog;
  if (providerQuery) {
    providers = matchProviders(catalog, providerQuery);
    if (providers.length === 0) {
      return fail(
        "unknown_provider",
        `No provider matches "${providerQuery}". Valid providers: ${providerCandidates(catalog).join(", ")}.`,
        providerCandidates(catalog),
      );
    }
    if (providers.length > 1 && !modelQuery) {
      return fail(
        "ambiguous_provider",
        `"${providerQuery}" matches several providers. Pass one instance id: ${providerCandidates(providers).join(", ")}.`,
        providerCandidates(providers),
      );
    }
  }

  let chosen: { readonly provider: CatalogProvider; readonly model: CatalogModel } | undefined;
  if (modelQuery) {
    const matches = matchModels(providers, modelQuery);
    if (matches.length === 0) {
      const scope = providers.flatMap((provider) =>
        provider.models.map((model) => describeModel(provider, model)),
      );
      const wanted = squash(modelQuery);
      const near = scope.filter((line) => {
        const text = squash(line);
        return text.includes(wanted) || (wanted.length > 3 && wanted.includes(text));
      });
      return fail(
        "unknown_model",
        `No model matches "${modelQuery}"${providerQuery ? ` on ${providerQuery}` : ""}. Valid models: ${scope.join("; ")}.`,
        near.length > 0 ? near : scope,
      );
    }
    if (matches.length > 1) {
      const lines = matches.map((entry) => describeModel(entry.provider, entry.model));
      return fail(
        "ambiguous_model",
        `"${modelQuery}" matches more than one model. Pass provider to pick one: ${lines.join("; ")}.`,
        lines,
      );
    }
    chosen = matches[0];
  } else if (providerQuery) {
    const provider = providers[0]!;
    const model = provider.models.find((entry) => entry.isDefault);
    if (!model) {
      return fail(
        "unknown_model",
        `${provider.displayName} has no default model. Pass model: ${provider.models.map((entry) => entry.slug).join(", ")}.`,
        provider.models.map((entry) => describeModel(provider, entry)),
      );
    }
    chosen = { provider, model };
  } else if (effortQuery && base) {
    const provider = catalog.find((entry) => entry.instanceId === base.instanceId);
    const model = provider?.models.find((entry) => entry.slug === base.model);
    if (provider && model) chosen = { provider, model };
  }

  if (!chosen) {
    return fail(
      "missing_target",
      "Pass preset, or model (optionally with provider and effort). Call list_models to see the choices.",
      presets.map((preset) => preset.name),
    );
  }

  const { provider, model } = chosen;
  if (!provider.ready) {
    return fail(
      "provider_not_ready",
      `${provider.displayName} is not ready: ${provider.notReadyReason ?? "not available"}.`,
    );
  }

  let effort: string | null = null;
  let options: ModelSelection["options"];
  if (effortQuery) {
    const resolved = resolveEffort(model, effortQuery);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    effort = resolved.optionId;
    options = [{ id: resolved.descriptorId, value: resolved.optionId }];
  }

  return {
    ok: true,
    target: {
      selection: {
        instanceId: provider.instanceId,
        model: model.slug,
        ...(options ? { options } : {}),
      },
      provider: provider.instanceId,
      providerName: provider.displayName,
      model: model.slug,
      modelName: model.name,
      effort,
      ignored: [],
    },
  };
}

/** The catalog the resolver and `list_models` read, taken from live provider snapshots. */
export function catalogFromProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<CatalogProvider> {
  return providers.map((provider) => {
    const notReadyReason = !provider.enabled
      ? "disabled in Settings"
      : !provider.installed
        ? "not installed"
        : !isProviderAvailable(provider)
          ? (provider.unavailableReason ?? "unavailable")
          : provider.status === "error"
            ? (provider.message ?? "reporting an error")
            : provider.auth.status === "unauthenticated"
              ? "not signed in"
              : undefined;
    return {
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? provider.instanceId,
      ready: notReadyReason === undefined,
      notReadyReason,
      models: provider.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        shortName: model.shortName,
        aliases: model.aliases ?? [],
        isDefault: model.isDefault === true,
        optionDescriptors: model.capabilities?.optionDescriptors ?? [],
      })),
    };
  });
}
