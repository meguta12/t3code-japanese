import {
  type CommandCodeSettings,
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { COMMANDCODE_EFFORT_OPTION_ID } from "../acp/CommandCodeAcpSupport.ts";

const COMMANDCODE_PRESENTATION = {
  displayName: "Command Code",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `--list-models` fetches the catalog over the network and takes several seconds.
const MODEL_LIST_TIMEOUT_MS = 20_000;

/** Command Code's own default, marked "(default)" by `--list-models`. */
export const COMMANDCODE_DEFAULT_MODEL_SLUG = "deepseek/deepseek-v4-flash";

/**
 * `session/new` offers an `effort` option per model with a model-specific value set, but the
 * session is the only place that reveals it and opening one from a health check is avoided.
 * So the picker shows one generic list (best effort); the adapter applies a value only when the
 * live session offers it. Two families are special-cased from what a live probe returned:
 * Haiku exposes no effort option and DeepSeek exposes `off|high|max`.
 */
const GENERIC_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
const DEEPSEEK_EFFORT_VALUES = ["off", "high", "max"] as const;
const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

export function commandCodeModelCapabilities(slug: string): ModelCapabilities {
  const lower = slug.toLowerCase();
  if (lower.startsWith("claude-haiku")) return EMPTY_CAPABILITIES;
  const values = lower.startsWith("deepseek/") ? DEEPSEEK_EFFORT_VALUES : GENERIC_EFFORT_VALUES;
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: COMMANDCODE_EFFORT_OPTION_ID,
        label: "Effort",
        options: values.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value })),
      }),
    ],
  });
}

const BUILT_IN_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: COMMANDCODE_DEFAULT_MODEL_SLUG,
    name: "deepseek-v4-flash",
    subProvider: "Open Source",
    isCustom: false,
    isDefault: true,
    capabilities: commandCodeModelCapabilities(COMMANDCODE_DEFAULT_MODEL_SLUG),
  },
];

const ANSI_PATTERN = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

/**
 * Parses `commandcode --list-models`:
 *
 *     Available models  ·  84 models
 *
 *     Open Source
 *
 *     deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning
 *     deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)
 *     ...
 *     Anthropic
 *
 *     claude-sonnet-5-5                      best combo of speed & intelligence (recommended)
 *     ...
 *     Pass the full id, or just the short name after the last "/":
 *
 * A model row is an id followed by two or more spaces and a description. A group heading is a
 * lone line without that gap. Parsing stops at the "Pass the full id" footer, which also drops
 * the headless-only "Decision models" section.
 */
export function parseCommandCodeModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();
  let group: string | undefined;
  let started = false;
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^available models/i.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (/^pass the full id/i.test(line)) break;
    const row = line.match(/^(\S+)\s{2,}(.+)$/);
    if (!row?.[1]) {
      group = line;
      continue;
    }
    const slug = row[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: slug.slice(slug.lastIndexOf("/") + 1),
      ...(group ? { subProvider: group } : {}),
      isCustom: false,
      ...(/\(default\)/i.test(row[2] ?? "") ? { isDefault: true } : {}),
      capabilities: commandCodeModelCapabilities(slug),
    });
  }
  return models;
}

export interface CommandCodeStatusOutput {
  /** True or false when the CLI said so, null when the text is not recognized. */
  readonly authenticated: boolean | null;
  readonly account?: string;
}

/**
 * Parses `commandcode status` ("Authentication verified", "Authenticated as <user>"). Only a
 * clean exit can prove login; a non-zero exit or "not logged in" wording means signed out.
 */
export function parseCommandCodeStatusOutput(
  output: string,
  exitCode: number,
): CommandCodeStatusOutput {
  const text = stripAnsi(output);
  if (
    /not (?:logged in|authenticated|signed in)|log ?in required|please (?:log ?in|login)/i.test(
      text,
    )
  ) {
    return { authenticated: false };
  }
  const account = text.match(/authenticated as\s+(\S+)/i)?.[1];
  if (exitCode === 0 && (account || /authentication verified/i.test(text))) {
    return { authenticated: true, ...(account ? { account } : {}) };
  }
  return { authenticated: exitCode === 0 ? null : false };
}

function commandCodeModels(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    customModels ?? [],
    commandCodeModelCapabilities("custom"),
  );
}

export function buildInitialCommandCodeProviderSnapshot(
  settings: CommandCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: COMMANDCODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: commandCodeModels(settings.customModels, BUILT_IN_FALLBACK_MODELS),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Command Code CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Command Code is disabled in T3 Code settings.",
          },
    });
  });
}

const runCommandCodeCli = (
  settings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "commandcode";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Health check: `--version` (installed), `status` (login), `--list-models` (catalog). None of
 * them opens an ACP session, so nothing can start MCP servers or hooks. `modelCache` keeps the
 * last good catalog so a failed or slow refresh does not blank the picker.
 */
export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv,
    modelCache: Ref.Ref<ReadonlyArray<ServerProviderModel>>,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const cachedModels = yield* Ref.get(modelCache);
    const fallbackModels = commandCodeModels(
      settings.customModels,
      cachedModels.length > 0 ? cachedModels : BUILT_IN_FALLBACK_MODELS,
    );

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Command Code is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runCommandCodeCli(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Command Code CLI health check failed.", { errorTag: error._tag });
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Command Code CLI (`commandcode`) is not installed or not on PATH."
            : "Failed to execute Command Code CLI health check.",
        },
      });
    }
    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Command Code CLI is installed but timed out while running `--version`.",
        },
      });
    }
    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Command Code CLI is installed but failed to run.",
        },
      });
    }

    const statusResult = yield* runCommandCodeCli(settings, ["status"], environment).pipe(
      Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    const status: CommandCodeStatusOutput =
      Result.isSuccess(statusResult) && Option.isSome(statusResult.success)
        ? parseCommandCodeStatusOutput(
            `${statusResult.success.value.stdout}\n${statusResult.success.value.stderr}`,
            statusResult.success.value.code,
          )
        : { authenticated: null };
    const auth: ServerProviderAuth =
      status.authenticated === true
        ? {
            status: "authenticated",
            type: "cached_token",
            label: status.account ? `Command Code (${status.account})` : "Command Code account",
          }
        : status.authenticated === false
          ? { status: "unauthenticated" }
          : { status: "unknown" };

    const modelsResult = yield* runCommandCodeCli(settings, ["--list-models"], environment).pipe(
      Effect.timeoutOption(MODEL_LIST_TIMEOUT_MS),
      Effect.result,
    );
    const listed =
      Result.isSuccess(modelsResult) &&
      Option.isSome(modelsResult.success) &&
      modelsResult.success.value.code === 0
        ? parseCommandCodeModelsOutput(modelsResult.success.value.stdout)
        : [];
    if (listed.length > 0) {
      yield* Ref.set(modelCache, listed);
    } else {
      yield* Effect.logWarning("Command Code model listing failed or returned no models.");
    }
    const models = commandCodeModels(
      settings.customModels,
      listed.length > 0
        ? listed
        : cachedModels.length > 0
          ? cachedModels
          : BUILT_IN_FALLBACK_MODELS,
    );

    if (auth.status === "unauthenticated") {
      return buildServerProvider({
        presentation: COMMANDCODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth,
          message: "Command Code CLI is installed but not logged in. Run `commandcode login`.",
        },
      });
    }

    return buildServerProvider({
      presentation: COMMANDCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: listed.length === 0 ? "warning" : "ready",
        auth,
        ...(listed.length === 0
          ? { message: "Command Code model list could not be loaded. Showing the last known list." }
          : {}),
      },
    });
  },
);

export const enrichCommandCodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Command Code version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
