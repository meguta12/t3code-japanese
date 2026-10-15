/** OpenCode 2 transport, kept behind the existing provider boundary. */
import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";
import type { OpenCodeSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { parseGenericCliVersion } from "./providerSnapshot.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
} from "./opencodeRuntime.ts";

export type OpenCode2Model = Awaited<ReturnType<OpenCodeClient["model"]["list"]>>["data"][number];
export type OpenCode2Agent = Awaited<ReturnType<OpenCodeClient["agent"]["list"]>>["data"][number];
export type OpenCode2Connection = ReturnType<typeof makeConnection>;

export const openCode2Request = <A>(method: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new OpenCodeRuntimeError({
        operation: method,
        detail: openCodeRuntimeErrorDetail(cause),
        cause,
      }),
  });

export function makeConnection(url: string, password: string, external: boolean) {
  const subscribed = Promise.withResolvers<void>();
  // A failure can arrive before the adapter begins waiting for the handshake.
  void subscribed.promise.catch(() => undefined);
  const client = OpenCode.make({
    baseUrl: url,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    fetch: async (input, init) => {
      const event = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      ).pathname.endsWith("/api/event");
      try {
        const response = await fetch(input, init);
        if (event) {
          if (response.ok) subscribed.resolve();
          else
            subscribed.reject(new Error(`OpenCode event stream returned HTTP ${response.status}`));
        }
        return response;
      } catch (error) {
        if (event) subscribed.reject(error);
        throw error;
      }
    },
  });
  return {
    url,
    external,
    client,
    subscribed: openCode2Request("event.subscribe", () => subscribed.promise),
    events: (signal: AbortSignal): Stream.Stream<OpenCodeEvent, OpenCodeRuntimeError> =>
      Stream.fromAsyncIterable(
        client.event.subscribe({ signal }),
        (cause) =>
          new OpenCodeRuntimeError({
            operation: "event.subscribe",
            detail: openCodeRuntimeErrorDetail(cause),
            cause,
          }),
      ),
  };
}

export const verifyOpenCode2 = (connection: OpenCode2Connection) =>
  openCode2Request("server.info", (signal) => connection.client.server.info({ signal })).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError((cause) =>
      cause instanceof OpenCodeRuntimeError
        ? cause
        : new OpenCodeRuntimeError({
            operation: "server.info",
            detail: "Timed out checking the OpenCode 2 server.",
            cause,
          }),
    ),
    Effect.flatMap((info) =>
      typeof info.version === "string" && compareSemverVersions(info.version, "2.0.18") >= 0
        ? Effect.succeed(info.version)
        : Effect.fail(
            new OpenCodeRuntimeError({
              operation: "server.info",
              detail: "T3 Code requires an OpenCode 2 server version 2.0.18 or newer.",
            }),
          ),
    ),
  );

export const makeOpenCode2Runtime = Effect.fn("makeOpenCode2Runtime")(function* (input: {
  settings: OpenCodeSettings;
  directory: string;
  environment: NodeJS.ProcessEnv;
}) {
  const runtime = yield* OpenCodeRuntime;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const password = input.settings.serverPassword || (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  let latest: OpenCode2Connection | undefined;

  const detect = !input.settings.enabled
    ? Effect.succeed(false)
    : input.settings.serverUrl.trim()
      ? verifyOpenCode2(
          makeConnection(input.settings.serverUrl, input.settings.serverPassword, true),
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      : runtime
          .runOpenCodeCommand({
            binaryPath: input.settings.binaryPath,
            args: ["--version"],
            environment: input.environment,
          })
          .pipe(
            Effect.map((output) => (parseGenericCliVersion(output.stdout) ?? "").startsWith("2.")),
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => false),
          );

  const connection = Effect.gen(function* () {
    if (latest) return latest;
    if (input.settings.serverUrl.trim()) {
      const external = makeConnection(
        input.settings.serverUrl,
        input.settings.serverPassword,
        true,
      );
      yield* verifyOpenCode2(external);
      latest = external;
    } else {
      const { OPENCODE_SERVER_PASSWORD: _legacy, ...environment } = input.environment;
      const server = yield* runtime
        .startOpenCodeServerProcess({
          binaryPath: input.settings.binaryPath,
          directory: input.directory,
          stdio: true,
          environment: { ...environment, OPENCODE_PASSWORD: password },
          verify: (url) => verifyOpenCode2(makeConnection(url, password, false)),
        })
        .pipe(Scope.provide(scope));
      latest = makeConnection(server.url, password, false);
    }
    return latest;
  }).pipe(lock.withPermits(1));

  const models = (directory: string) =>
    connection.pipe(
      Effect.flatMap(({ client }) =>
        openCode2Request("model.list", (signal) =>
          client.model.list({ location: { directory } }, { signal }),
        ).pipe(
          Effect.map((result) => result.data),
          Effect.repeat({
            until: (catalog) => catalog.length > 0,
            schedule: Schedule.spaced("250 millis"),
          }),
          Effect.timeoutOption("5 seconds"),
          Effect.map((result) => (result._tag === "Some" ? result.value : [])),
        ),
      ),
    );
  const workspace = (directory: string) =>
    connection.pipe(
      Effect.flatMap(({ client }) =>
        Effect.all(
          {
            skills: openCode2Request("skill.list", (signal) =>
              client.skill.list({ location: { directory } }, { signal }),
            ),
            commands: openCode2Request("command.list", (signal) =>
              client.command.list({ location: { directory } }, { signal }),
            ),
            agents: openCode2Request("agent.list", (signal) =>
              client.agent.list({ location: { directory } }, { signal }),
            ),
          },
          { concurrency: "unbounded" },
        ),
      ),
    );
  return { detect, connection, models, workspace };
});
export type OpenCode2Runtime = Effect.Success<ReturnType<typeof makeOpenCode2Runtime>>;
