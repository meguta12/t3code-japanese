// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  CommandCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeCommandCodeAdapter, type CommandCodeAdapterShape } from "./CommandCodeAdapter.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const PROVIDER = ProviderDriverKind.make("commandcode");
const INSTANCE = ProviderInstanceId.make("commandcode");

class CommandCodeAdapter extends Context.Service<CommandCodeAdapter, CommandCodeAdapterShape>()(
  "t3/provider/Layers/CommandCodeAdapter.test/CommandCodeAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeProbeWrapper(
  requestLogPath: string,
  argvLogPath: string,
  extraEnv?: Record<string, string>,
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "commandcode-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-agent",
    env: { T3_ACP_COMMANDCODE: "1", T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
  });
}

async function readRequests(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

const makeWorkspace = Effect.promise(async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "commandcode-adapter-"));
  const requestLogPath = NodePath.join(dir, "requests.ndjson");
  const argvLogPath = NodePath.join(dir, "argv.txt");
  await NodeFSP.writeFile(requestLogPath, "", "utf8");
  return { dir, requestLogPath, argvLogPath };
});

const commandCodeAdapterTestLayer = it.layer(
  Layer.effect(
    CommandCodeAdapter,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const resolveSettings = serverSettings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.commandcode),
        Effect.orDie,
      );
      return yield* makeCommandCodeAdapter(decodeSettings({}), { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-commandcode-adapter-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

commandCodeAdapterTestLayer("CommandCodeAdapterLive", (it) => {
  it.effect(
    "runs a prompt, resolves the model to the agent's id and effort, and reports the served model",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const settings = yield* ServerSettingsService;
        const { dir, requestLogPath, argvLogPath } = yield* makeWorkspace;
        const threadId = ThreadId.make("commandcode-happy-path");
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* settings.updateSettings({ providers: { commandcode: { binaryPath: wrapperPath } } });

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId,
          provider: PROVIDER,
          cwd: dir,
          runtimeMode: "approval-required",
          // The catalog lists the lowercase `--list-models` id; the agent only accepts its own casing.
          modelSelection: {
            instanceId: INSTANCE,
            model: "moonshotai/kimi-k3",
            options: [{ id: "effort", value: "high" }],
          },
        });
        assert.equal(session.provider, "commandcode");
        assert.equal(session.model, "moonshotai/Kimi-K3");
        assert.deepStrictEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "mock-session-1",
        });

        yield* adapter.sendTurn({ threadId, input: "hello mock", attachments: [] });
        const events = Array.from(yield* Fiber.join(eventsFiber));

        for (const type of [
          "session.started",
          "thread.started",
          "turn.started",
          "content.delta",
          "turn.completed",
        ] as const) {
          assert.include(
            events.map((event) => event.type),
            type,
          );
        }
        const started = events.find((event) => event.type === "turn.started");
        assert.deepStrictEqual(started?.type === "turn.started" ? started.payload : null, {
          model: "moonshotai/Kimi-K3",
        });
        const delta = events.find((event) => event.type === "content.delta");
        assert.equal(
          delta?.type === "content.delta" ? delta.payload.delta : null,
          "hello from mock",
        );

        const requests = yield* Effect.promise(() => readRequests(requestLogPath));
        const configWrites = requests
          .filter((entry) => entry.method === "session/set_config_option")
          .map((entry) => [entry.params?.configId, entry.params?.value]);
        assert.deepStrictEqual(configWrites, [
          ["model", "moonshotai/Kimi-K3"],
          ["effort", "high"],
        ]);
        const argv = yield* Effect.promise(() => NodeFSP.readFile(argvLogPath, "utf8"));
        assert.include(argv, "acp");
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("maps runtime and interaction modes onto Command Code permission modes", () =>
    Effect.gen(function* () {
      const adapter = yield* CommandCodeAdapter;
      const settings = yield* ServerSettingsService;
      const { dir, requestLogPath, argvLogPath } = yield* makeWorkspace;
      const threadId = ThreadId.make("commandcode-modes");
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { commandcode: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: dir,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "plan this", attachments: [] });
      yield* adapter.sendTurn({
        threadId,
        input: "now plan",
        interactionMode: "plan",
        attachments: [],
      });
      yield* adapter.sendTurn({ threadId, input: "back to work", attachments: [] });

      const modes = (yield* Effect.promise(() => readRequests(requestLogPath)))
        .filter((entry) => entry.method === "session/set_mode")
        .map((entry) => entry.params?.modeId);
      // The permission mode is applied once per change, never re-sent for an unchanged mode.
      assert.deepStrictEqual(modes, ["bypass", "plan", "bypass"]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "skips an effort value the live session does not offer and models without an effort option",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CommandCodeAdapter;
        const settings = yield* ServerSettingsService;
        const { dir, requestLogPath, argvLogPath } = yield* makeWorkspace;
        const threadId = ThreadId.make("commandcode-effort");
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* settings.updateSettings({ providers: { commandcode: { binaryPath: wrapperPath } } });

        yield* adapter.startSession({
          threadId,
          provider: PROVIDER,
          cwd: dir,
          runtimeMode: "approval-required",
          modelSelection: {
            instanceId: INSTANCE,
            model: "z-ai/glm-5.3-flashx",
            // The mock offers default|low|high|max, so `medium` must be dropped, not sent.
            options: [{ id: "effort", value: "medium" }],
          },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "go",
          attachments: [],
          modelSelection: {
            instanceId: INSTANCE,
            model: "claude-haiku-4-5",
            options: [{ id: "effort", value: "high" }],
          },
        });

        const writes = (yield* Effect.promise(() => readRequests(requestLogPath)))
          .filter((entry) => entry.method === "session/set_config_option")
          .map((entry) => [entry.params?.configId, entry.params?.value]);
        // Haiku resolves through its dated id and has no effort option to write.
        assert.deepStrictEqual(writes, [["model", "claude-haiku-4-5-20251001"]]);
        assert.equal(
          (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)?.model,
          "claude-haiku-4-5-20251001",
        );
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("rejects user-input replies because the agent never asks for any", () =>
    Effect.gen(function* () {
      const adapter = yield* CommandCodeAdapter;
      const settings = yield* ServerSettingsService;
      const { dir, requestLogPath, argvLogPath } = yield* makeWorkspace;
      const threadId = ThreadId.make("commandcode-user-input");
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { commandcode: { binaryPath: wrapperPath } } });
      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: dir,
        runtimeMode: "approval-required",
      });
      const error = yield* adapter
        .respondToUserInput(threadId, "request-1" as never, {})
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      yield* adapter.stopSession(threadId);
    }),
  );
});
