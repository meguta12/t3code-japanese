/**
 * Command Code (`commandcode acp`) ACP helpers.
 *
 * Observed protocol (Command Code 1.74.x), which differs from the other ACP agents:
 * - `session/new` returns `modes` (default, auto-accept, plan, dont-ask, bypass) but no `mode`
 *   config option, so the shared runtime's `setMode` (config option `mode`) fails with
 *   "Unknown config option". Modes are switched with the plain `session/set_mode` request.
 * - The `model` config option lists canonical ids whose casing and date suffixes differ from
 *   `commandcode --list-models` (`moonshotai/Kimi-K3` vs `moonshotai/kimi-k3`,
 *   `claude-haiku-4-5-20251001` vs `claude-haiku-4-5`). Unknown ids are rejected, so requested
 *   slugs are resolved against the live option values.
 * - The `effort` config option (category `thought_level`) appears per model with a model-specific
 *   value set (for example `default|low|medium|high|xhigh|max` or `default|off|high|max`) and is
 *   absent for models without reasoning control.
 * - `session/load` and `session/resume` both succeed for unknown ids, so a stale resume cursor
 *   silently yields an empty session instead of an error.
 */
import {
  type CommandCodeSettings,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  collectSessionConfigOptionValues,
  findSessionConfigOption,
  type AcpSessionModeState,
} from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const COMMANDCODE_AUTH_METHOD_ID = "command-code-cli";
export const COMMANDCODE_MODEL_CONFIG_ID = "model";
export const COMMANDCODE_EFFORT_CONFIG_ID = "effort";
export const COMMANDCODE_EFFORT_OPTION_ID = "effort";
/** The effort value that means "the model's own default". */
export const COMMANDCODE_DEFAULT_EFFORT = "default";

type CommandCodeAcpRuntimeSettings = Pick<CommandCodeSettings, "binaryPath">;

export interface CommandCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly commandCodeSettings: CommandCodeAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildCommandCodeAcpSpawnInput(
  settings: CommandCodeAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "commandcode",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeCommandCodeAcpRuntime = (
  input: CommandCodeAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCommandCodeAcpSpawnInput(
          input.commandCodeSettings,
          input.cwd,
          input.environment,
        ),
        authMethodId: COMMANDCODE_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Maps T3's runtime and interaction modes onto Command Code's permission modes
 * (`--permission-mode standard|accept-edits|yolo|plan` in the CLI, ids below over ACP).
 */
export function resolveCommandCodeModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const wanted =
    input.interactionMode === "plan"
      ? "plan"
      : input.runtimeMode === "approval-required"
        ? "default"
        : input.runtimeMode === "auto-accept-edits"
          ? "auto-accept"
          : input.runtimeMode === "auto"
            ? "dont-ask"
            : "bypass";
  return input.modeState?.availableModes.some((mode) => mode.id === wanted) ? wanted : undefined;
}

/**
 * Resolves a requested slug (usually the lowercase `--list-models` id) to the id the ACP
 * `model` option accepts: exact, then case-insensitive, then a dated variant
 * (`claude-haiku-4-5` -> `claude-haiku-4-5-20251001`), then the short name after the last `/`.
 * Unknown slugs are returned unchanged so the agent reports them.
 */
export function resolveCommandCodeModelValue(
  requested: string | null | undefined,
  available: ReadonlyArray<string>,
): string | undefined {
  const slug = requested?.trim();
  if (!slug) return undefined;
  if (available.includes(slug)) return slug;
  const lower = slug.toLowerCase();
  const ci = available.find((value) => value.toLowerCase() === lower);
  if (ci) return ci;
  const dated = available.find((value) => {
    const candidate = value.toLowerCase();
    return candidate.startsWith(`${lower}-`) && /^\d{6,8}$/.test(candidate.slice(lower.length + 1));
  });
  if (dated) return dated;
  const short = lower.slice(lower.lastIndexOf("/") + 1);
  const shortMatches = available.filter(
    (value) => value.toLowerCase().slice(value.lastIndexOf("/") + 1) === short,
  );
  return shortMatches.length === 1 ? shortMatches[0] : slug;
}

function selectionEffort(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  const value = selections?.find((entry) => entry.id === COMMANDCODE_EFFORT_OPTION_ID)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface CommandCodeSessionConfigRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

/**
 * Applies the model and effort of a turn. Effort is session state that outlives a model switch,
 * so an absent selection resets it to the model default when the live option offers one.
 * Values the live option does not list are skipped: T3 exposes one generic effort list while the
 * set a model really accepts is only known from the session.
 */
export function applyCommandCodeModelSelection<E>(input: {
  readonly runtime: CommandCodeSessionConfigRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const readModel = (options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) =>
      findSessionConfigOption(options, COMMANDCODE_MODEL_CONFIG_ID);
    let options = yield* input.runtime.getConfigOptions;
    const modelOption = readModel(options);
    if (modelOption && input.model) {
      const resolved = resolveCommandCodeModelValue(
        input.model,
        collectSessionConfigOptionValues(modelOption),
      );
      const current = modelOption.type === "select" ? modelOption.currentValue : undefined;
      if (resolved && resolved !== current) {
        yield* input.runtime
          .setConfigOption(COMMANDCODE_MODEL_CONFIG_ID, resolved)
          .pipe(Effect.mapError(input.mapError));
        options = yield* input.runtime.getConfigOptions;
      }
    }
    const effortOption = findSessionConfigOption(options, COMMANDCODE_EFFORT_CONFIG_ID);
    if (effortOption && effortOption.type === "select") {
      const offered = collectSessionConfigOptionValues(effortOption);
      const wanted = selectionEffort(input.selections) ?? COMMANDCODE_DEFAULT_EFFORT;
      if (offered.includes(wanted) && effortOption.currentValue !== wanted) {
        yield* input.runtime
          .setConfigOption(COMMANDCODE_EFFORT_CONFIG_ID, wanted)
          .pipe(Effect.mapError(input.mapError));
        options = yield* input.runtime.getConfigOptions;
      }
    }
    const finalModel = readModel(options);
    return finalModel?.type === "select" ? finalModel.currentValue : undefined;
  });
}
