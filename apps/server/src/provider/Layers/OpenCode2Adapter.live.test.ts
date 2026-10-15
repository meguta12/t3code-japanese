import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import {
  OpenCodeSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import { makeOpenCode2Runtime } from "../OpenCode2Runtime.ts";
import { makeOpenCode2Adapter } from "./OpenCode2Adapter.ts";
import { checkOpenCode2ProviderStatus } from "./OpenCodeProvider.ts";

const decodeSettings = Schema.decodeSync(OpenCodeSettings);

it.live.skipIf(process.env.T3_OPENCODE2_LIVE !== "1")(
  "runs the installed OpenCode 2 and a zero-cost model in an isolated home",
  () =>
    Effect.gen(function* () {
      const report: {
        version?: string;
        model?: string;
        modelCount?: number;
        reply?: string;
        outcome?: unknown;
      } = {};
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-opencode2-live-"))),
        (root) =>
          Effect.promise(async () => {
            if (process.env.T3_OPENCODE2_REPORT)
              await NodeFSP.writeFile(
                process.env.T3_OPENCODE2_REPORT,
                JSON.stringify(report, null, 2),
              );
            await NodeFSP.rm(root, { recursive: true, force: true });
          }),
      );
      const home = NodePath.join(root, "home");
      const workspace = NodePath.join(root, "workspace");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(home);
        await NodeFSP.mkdir(workspace);
      });
      yield* Effect.gen(function* () {
        const settings = decodeSettings({
          enabled: true,
          binaryPath: "/opt/homebrew/bin/opencode",
        });
        const runtime = yield* makeOpenCode2Runtime({
          settings,
          directory: workspace,
          environment: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: NodePath.join(home, ".config"),
            XDG_DATA_HOME: NodePath.join(home, ".local/share"),
            XDG_CACHE_HOME: NodePath.join(home, ".cache"),
            XDG_STATE_HOME: NodePath.join(home, ".local/state"),
            OPENCODE_CONFIG_CONTENT: "{}",
          },
        });
        expect(yield* runtime.detect).toBe(true);
        const status = yield* checkOpenCode2ProviderStatus(settings, workspace, runtime);
        if (status.version) report.version = status.version;
        expect(status.status, status.message).toBe("ready");
        const models = yield* runtime.models(workspace);
        report.modelCount = models.length;
        const free = models.filter(
          (model) =>
            model.enabled &&
            model.capabilities.tools &&
            model.cost.length > 0 &&
            model.cost.every(
              (tier) =>
                tier.input === 0 &&
                tier.output === 0 &&
                tier.cache.read === 0 &&
                tier.cache.write === 0,
            ),
        );
        const selected = free.find((model) => model.id === "big-pickle") ?? free[0];
        expect(
          selected,
          "No zero-cost model was listed; paid models must never be used as a fallback.",
        ).toBeDefined();
        if (!selected) return;
        const modelSelection = {
          instanceId: ProviderInstanceId.make("opencode"),
          model: `${selected.providerID}/${selected.id}`,
        };
        report.model = modelSelection.model;
        const adapter = yield* makeOpenCode2Adapter(settings, runtime);
        const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Queue.offer(queue, event)),
          Effect.forkScoped,
        );
        const session = yield* adapter.startSession({
          threadId: ThreadId.make("free-model-live-check"),
          cwd: workspace,
          runtimeMode: "full-access",
          modelSelection,
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          modelSelection,
          input: "Reply with exactly T3_FREE_OK and nothing else. Do not call any tools.",
        });
        let answer = "";
        while (true) {
          const event = yield* Queue.take(queue);
          if (event.type === "content.delta" && event.payload.streamKind === "assistant_text")
            answer += event.payload.delta;
          if (event.type === "turn.completed") {
            report.reply = answer;
            report.outcome = event.payload;
            expect(event.payload.state, event.payload.errorMessage).toBe("completed");
            expect(answer).toContain("T3_FREE_OK");
            break;
          }
        }
        yield* adapter.stopSession(session.threadId);
      }).pipe(
        Effect.provide(ServerConfig.layerTest(workspace, NodePath.join(root, "t3"))),
        Effect.provide(OpenCodeRuntimeLive),
        Effect.provide(NodeServices.layer),
      );
    }),
  120_000,
);
