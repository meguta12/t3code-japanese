import * as NodeOS from "node:os";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { removedEnvironmentKeys } from "../antigravityAuthSupport.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";
import {
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
} from "../providerSnapshot.ts";

/**
 * Antigravity publishes remaining quota only through its standalone `agy` CLI:
 * `agy -p "/usage" --output-format json` answers locally, without starting an
 * agent turn or spending quota (documented in `agy changelog`, added in 1.1.11).
 * The CLI keeps its own Google login, separate from the ACP server T3 drives,
 * so the numbers belong to the account `agy` is signed in as. Older builds
 * treat `/usage` as ordinary prompt text and would send it to the model, so
 * the version is checked before the command is ever run.
 */
const MIN_AGY_VERSION = [1, 1, 11] as const;
const VERSION_TIMEOUT = "5 seconds";
const USAGE_TIMEOUT = "20 seconds";
const SESSION_MINS = 300;
const WEEK_MINS = 10_080;

const UsageBucket = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.optional(Schema.Number),
  reset_time: Schema.optional(Schema.String),
});
const UsageGroup = Schema.Struct({
  name: Schema.String,
  buckets: Schema.optional(Schema.Array(UsageBucket)),
});
const AgyUsageOutput = Schema.Struct({
  num_turns: Schema.optional(Schema.Number),
  command: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      data: Schema.optional(Schema.Struct({ groups: Schema.optional(Schema.Array(UsageGroup)) })),
    }),
  ),
});
const decodeUsageOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(AgyUsageOutput));

/** `Gemini Models` -> `Gemini`, `Claude and GPT models` -> `Claude & GPT`. */
function groupLabel(name: string): string {
  return name
    .replace(/\s+models?$/i, "")
    .replace(/\s+and\s+/gi, " & ")
    .trim();
}

function versionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const parts = version.split(".").map(Number);
  for (const [index, required] of minimum.entries()) {
    const actual = parts[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}

export function antigravityUsageToLimits(output: typeof AgyUsageOutput.Type, checkedAt: string) {
  const windows: ServerProviderUsageWindow[] = [];
  for (const group of output.command?.data?.groups ?? []) {
    const label = groupLabel(group.name);
    for (const bucket of group.buckets ?? []) {
      const remaining = bucket.remaining_fraction;
      if (remaining === undefined || !Number.isFinite(remaining)) continue;
      const kind =
        bucket.window === "5h" ? "session" : bucket.window === "weekly" ? "weekly" : "other";
      const reset = bucket.reset_time ? DateTime.make(bucket.reset_time) : Option.none();
      windows.push({
        id: bucket.id,
        kind,
        label: `${label} ${kind === "session" ? "5h" : kind === "weekly" ? "Weekly" : (bucket.name ?? bucket.id)}`,
        usedPercent: clampPercent((1 - remaining) * 100),
        ...(kind === "session"
          ? { windowDurationMins: SESSION_MINS }
          : kind === "weekly"
            ? { windowDurationMins: WEEK_MINS }
            : {}),
        ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
      });
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Antigravity reports no quota for the account the agy CLI is signed in as.",
      });
}

/** The user's own `agy` install: PATH first, then where its installer puts it. */
const runAgy = Effect.fn("runAgy")(function* (
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
  const candidates = ["agy", path.join(home, ".local", "bin", "agy")];
  let missing: unknown;
  for (const command of candidates) {
    const attempt = yield* Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
      return yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          shell: spawnCommand.shell,
        }),
      );
    }).pipe(Effect.result);
    if (attempt._tag === "Success") return attempt.success;
    if (!isCommandMissingCause(attempt.failure)) return yield* Effect.fail(attempt.failure);
    missing = attempt.failure;
  }
  return yield* Effect.fail(missing);
});

/**
 * Reads the remaining quota windows from the `agy` CLI. Only the `/usage`
 * read-only command runs, and its output is checked to be a zero-turn local
 * answer. No credential is read or passed along by T3; the CLI uses its own.
 */
export const readAntigravityUsageLimits = Effect.fn("readAntigravityUsageLimits")(function* (
  instanceEnvironment: NodeJS.ProcessEnv = process.env,
) {
  // API keys and project overrides would switch the CLI to an account whose quota
  // is not the Google login being reported, so they never reach it.
  const environment = Object.fromEntries(
    Object.entries(instanceEnvironment).filter(
      ([key]) => !removedEnvironmentKeys.has(key.toUpperCase()),
    ),
  );
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Antigravity could not read usage limits.",
  });
  const version = yield* runAgy(["--version"], environment).pipe(
    Effect.timeout(VERSION_TIMEOUT),
    Effect.map((result) => (result.code === 0 ? parseGenericCliVersion(result.stdout) : null)),
    Effect.result,
  );
  if (version._tag === "Failure") {
    return isCommandMissingCause(version.failure)
      ? makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Install the Antigravity CLI (agy) to see remaining quota.",
        })
      : probeFailed;
  }
  if (version.success === null) return probeFailed;
  if (!versionAtLeast(version.success, MIN_AGY_VERSION)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Update the Antigravity CLI (agy) to 1.1.11 or newer to see remaining quota.",
    });
  }
  return yield* Effect.gen(function* () {
    const result = yield* runAgy(["-p", "/usage", "--output-format", "json"], environment);
    if (result.code !== 0) return probeFailed;
    const output = yield* decodeUsageOutput(result.stdout);
    // A local slash-command answer never takes a turn.
    return output.num_turns === 0 && output.command?.name === "usage"
      ? antigravityUsageToLimits(output, checkedAt)
      : probeFailed;
  }).pipe(
    Effect.timeout(USAGE_TIMEOUT),
    Effect.orElseSucceed(() => probeFailed),
  );
});
