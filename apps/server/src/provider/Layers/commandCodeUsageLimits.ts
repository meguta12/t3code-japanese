import * as NodeOS from "node:os";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

/**
 * Command Code's own `/usage` screen reads these two read-only GET routes of
 * its production API with the same login `commandcode status` reports. The
 * rolling 5-hour and weekly caps are in `windowLimits` of the credits
 * response; `used` and `cap` are in credit dollars, `resetAt` is epoch millis.
 */
const COMMANDCODE_API_BASE = "https://api.commandcode.ai";
const SESSION_MINS = 300;
const WEEK_MINS = 10_080;

const CommandCodeAuthFile = Schema.Struct({ apiKey: Schema.optional(Schema.String) });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(CommandCodeAuthFile));
const WindowLimit = Schema.NullOr(
  Schema.Struct({
    used: Schema.optional(Schema.Number),
    cap: Schema.optional(Schema.Number),
    exceeded: Schema.optional(Schema.NullOr(Schema.Boolean)),
    resetAt: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
);
const CommandCodeCreditsResponse = Schema.Struct({
  windowLimits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        limited: Schema.optional(Schema.NullOr(Schema.Boolean)),
        fiveHour: Schema.optional(WindowLimit),
        weekly: Schema.optional(WindowLimit),
      }),
    ),
  ),
});
const CommandCodeWhoamiResponse = Schema.Struct({
  org: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.optional(Schema.String) }))),
});

function toWindow(
  limit: typeof WindowLimit.Type | undefined,
  base: Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "windowDurationMins">,
): ServerProviderUsageWindow | undefined {
  if (!limit || limit.cap === undefined || !Number.isFinite(limit.cap) || limit.cap <= 0) {
    return undefined;
  }
  const used = limit.used !== undefined && Number.isFinite(limit.used) ? limit.used : 0;
  const reset = limit.resetAt ? DateTime.make(limit.resetAt) : Option.none();
  return {
    ...base,
    // `exceeded` is the server's verdict; trust it over rounding in used / cap.
    usedPercent: limit.exceeded === true ? 100 : clampPercent((used / limit.cap) * 100),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
  };
}

export function commandCodeCreditsToLimits(
  response: typeof CommandCodeCreditsResponse.Type,
  checkedAt: string,
) {
  const windows = [
    toWindow(response.windowLimits?.fiveHour, {
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: SESSION_MINS,
    }),
    toWindow(response.windowLimits?.weekly, {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: WEEK_MINS,
    }),
  ].filter((window) => window !== undefined);
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "This Command Code plan reports no rolling usage limits.",
      });
}

/** The login the CLI itself uses: its API-key variable, else `~/.commandcode/auth.json`. */
const readCommandCodeApiKey = Effect.fn("readCommandCodeApiKey")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fromEnvironment = environment.COMMAND_CODE_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
  const contents = yield* fs.readFileString(path.join(home, ".commandcode", "auth.json")).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
  );
  return (yield* decodeAuthFile(contents)).apiKey?.trim() || undefined;
});

/**
 * Reads the signed-in account's rolling limits. The key stays in this
 * function's memory and every failure collapses to a fixed message, so nothing
 * from the request (headers included) can reach a log or a snapshot.
 */
export const readCommandCodeUsageLimits = Effect.fn("readCommandCodeUsageLimits")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const token = yield* readCommandCodeApiKey(environment);
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const client = yield* HttpClient.HttpClient;
    const get = <A, I>(route: string, schema: Schema.Codec<A, I>) =>
      client
        .execute(
          HttpClientRequest.get(`${COMMANDCODE_API_BASE}${route}`).pipe(
            HttpClientRequest.bearerToken(token),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        );
    // Organization seats are metered per org; the CLI asks for the org it belongs to.
    const whoami = yield* get("/alpha/whoami?limits=1", CommandCodeWhoamiResponse);
    const orgId = whoami.org?.id;
    const credits = yield* get(
      orgId
        ? `/alpha/billing/credits?${new URLSearchParams({ orgId }).toString()}`
        : "/alpha/billing/credits",
      CommandCodeCreditsResponse,
    );
    return commandCodeCreditsToLimits(credits, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Command Code could not read usage limits.",
      }),
    ),
  );
});
