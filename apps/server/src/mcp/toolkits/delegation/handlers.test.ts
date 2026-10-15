import {
  DEFAULT_SERVER_SETTINGS,
  DELEGATION_ORIGIN_ACTIVITY_KIND,
  DELEGATION_STARTED_ACTIVITY_KIND,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Tool } from "effect/unstable/ai";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DelegationToolkitHandlersLive,
  deriveDelegatedTaskStatus,
  finalAssistantMessage,
} from "./handlers.ts";
import { DelegationToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const PARENT_ID = ThreadId.make("parent-thread");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-01T00:01:00.000Z";
const T2 = "2026-10-01T00:02:00.000Z";
const T_AFTER = "2026-10-01T01:00:00.000Z";

// Every draw differs, so each generated thread, message and command id is unique.
let randomSeed = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(++randomSeed % 256),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  threadId: ThreadId = PARENT_ID,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: CLAUDE,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const effort = (id: string, values: ReadonlyArray<string>) => ({
  id,
  label: "Reasoning",
  type: "select" as const,
  options: values.map((value) => ({ id: value, label: value })),
});

const provider = (
  instanceId: ProviderInstanceId,
  displayName: string,
  models: ServerProvider["models"],
): ServerProvider => ({
  instanceId,
  driver: instanceId as unknown as ServerProvider["driver"],
  displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: T0,
  models,
  slashCommands: [],
  skills: [],
});

const providers: ReadonlyArray<ServerProvider> = [
  provider(CODEX, "Codex", [
    {
      slug: "gpt-6.1-sol",
      name: "GPT-6.1-Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [effort("reasoningEffort", ["low", "high", "xhigh", "ultra"])],
      },
    },
  ]),
  provider(CLAUDE, "Claude", [
    {
      slug: "claude-fable-5-1",
      name: "Claude Fable 5.1",
      isCustom: false,
      isDefault: true,
      capabilities: { optionDescriptors: [effort("effort", ["low", "high", "max"])] },
    },
  ]),
];

const makeShell = (
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: CLAUDE, model: "claude-fable-5-1" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: "feature/x",
  worktreePath: "/workspace/project-wt",
  pullRequests: [],
  latestTurn: null,
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: T0,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const turn = (
  state: "running" | "completed" | "error" | "interrupted",
  assistantMessageId: string | null = null,
) =>
  ({
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: T1,
    startedAt: T1,
    completedAt: state === "running" ? null : T2,
    assistantMessageId: assistantMessageId === null ? null : MessageId.make(assistantMessageId),
  }) as const;

const activity = (kind: string, id: string, payload: unknown): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind,
  summary: kind,
  payload,
  turnId: null,
  createdAt: T0,
});

interface HarnessState {
  readonly shells: Map<ThreadId, OrchestrationThreadShell>;
  readonly activities: Map<ThreadId, Array<OrchestrationThreadActivity>>;
  readonly details: Map<ThreadId, Pick<OrchestrationThread, "messages" | "latestTurn">>;
  readonly commands: Array<OrchestrationCommand>;
}

interface HarnessOptions {
  readonly settings?: Partial<ServerSettings>;
  readonly events?: (state: HarnessState) => Stream.Stream<OrchestrationEvent>;
  readonly setup?: (state: HarnessState) => void;
  readonly onSubscribe?: (state: HarnessState) => void;
  readonly onDispatch?: (command: OrchestrationCommand, state: HarnessState) => void;
}

const sessionEvent = (threadId: ThreadId) =>
  ({
    type: "thread.session-set",
    aggregateKind: "thread",
    aggregateId: threadId,
    payload: { threadId },
  }) as unknown as OrchestrationEvent;

/** Adopts a delegated child the way the projections would after the harness' dispatches. */
const adoptChild = (
  state: HarnessState,
  childId: string,
  overrides: Partial<OrchestrationThreadShell> = {},
  parentId: ThreadId = PARENT_ID,
) => {
  const id = ThreadId.make(childId);
  state.shells.set(id, makeShell(id, { title: `[委譲] ${childId}`, ...overrides }));
  state.activities.set(id, [
    activity(DELEGATION_ORIGIN_ACTIVITY_KIND, `origin-${childId}`, { parentThreadId: parentId }),
  ]);
  state.activities.set(parentId, [
    ...(state.activities.get(parentId) ?? []),
    activity(DELEGATION_STARTED_ACTIVITY_KIND, `started-${childId}`, {
      childThreadId: childId,
      title: `[委譲] ${childId}`,
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "ultra",
      createdAt: T0,
    }),
  ]);
  return id;
};

const makeHarness = Effect.fn("makeDelegationHarness")(function* (options: HarnessOptions = {}) {
  const state: HarnessState = {
    shells: new Map([[PARENT_ID, makeShell(PARENT_ID, { title: "Main thread" })]]),
    activities: new Map(),
    details: new Map(),
    commands: [],
  };
  options.setup?.(state);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.sync(() => {
      state.commands.push(command);
      options.onDispatch?.(command, state);
      // Mirror what the projections would make of the commands the tools issue.
      if (command.type === "thread.create") {
        state.shells.set(
          command.threadId,
          makeShell(command.threadId, {
            title: command.title,
            projectId: command.projectId,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            branch: command.branch,
            worktreePath: command.worktreePath,
            latestUserMessageAt: null,
          }),
        );
      } else if (command.type === "thread.activity.append") {
        state.activities.set(command.threadId, [
          ...(state.activities.get(command.threadId) ?? []),
          command.activity,
        ]);
      } else if (command.type === "thread.turn.start") {
        const shell = state.shells.get(command.threadId);
        if (shell) {
          // The test clock starts at the epoch, so stamp a time after every fixture turn.
          state.shells.set(command.threadId, { ...shell, latestUserMessageAt: T_AFTER });
        }
      }
      return { sequence: 1 };
    });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(Option.fromNullishOr(state.shells.get(threadId))),
      listThreadActivitiesByKinds: (threadId, kinds) =>
        Effect.succeed(
          (state.activities.get(threadId) ?? []).filter((entry) => kinds.includes(entry.kind)),
        ),
      getThreadDetailById: (threadId) =>
        Effect.succeed(
          Option.fromNullishOr(state.details.get(threadId) as OrchestrationThread | undefined),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch,
      subscribeDomainEvents: Effect.sync(() => {
        options.onSubscribe?.(state);
        return options.events ? options.events(state) : Stream.empty;
      }),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        enableAgentDelegation: true,
        delegationPresets: [
          {
            id: "impl",
            name: "実装役",
            modelSelection: {
              instanceId: CODEX,
              model: "gpt-6.1-sol",
              options: [{ id: "reasoningEffort", value: "ultra" }],
            },
          },
        ],
        ...options.settings,
      }),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* DelegationToolkit.pipe(
    Effect.provide(DelegationToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof DelegationToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["delegation"],
    threadId: ThreadId = PARENT_ID,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof DelegationToolkit.tools)[Name]>,
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(capabilities, threadId),
      ),
      Effect.provide(dependencies),
    );
  return { state, call };
});

const taskId = (id: string) => ThreadId.make(id);

describe("delegation toolkit gating", () => {
  it.effect("serves a session started before delegation was switched on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("list_models", {}, ["pull-requests"]);
      expect(result.providers.length).toBeGreaterThan(0);
    }),
  );

  it.effect("refuses once the setting is switched off, even with a credential already issued", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ settings: { enableAgentDelegation: false } });
      const error = yield* harness
        .call("delegate_task", { prompt: "x", preset: "実装役" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError" });
      expect(harness.state.commands).toEqual([]);
    }),
  );

  it.effect(
    "refuses a delegated thread even if its credential somehow carries the capability",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ setup: (state) => void adoptChild(state, "child-a") });
        const error = yield* harness
          .call(
            "delegate_task",
            { prompt: "x", preset: "実装役" },
            ["delegation"],
            taskId("child-a"),
          )
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DelegationRejectedError", code: "nested_delegation" });
        expect(harness.state.commands).toEqual([]);
      }),
  );
});

describe("existing delegated tasks after disabling delegation", () => {
  it.effect("allows owned waits and stops while rejecting sends and new tasks", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: { enableAgentDelegation: false },
        setup: (state) => {
          adoptChild(state, "done", { latestTurn: turn("completed") });
          adoptChild(state, "busy", { latestTurn: turn("running") });
          adoptChild(state, "other", {}, ThreadId.make("other-parent"));
        },
      });
      expect((yield* harness.call("wait_delegated_task", { taskId: taskId("done") })).status).toBe(
        "completed",
      );
      expect(
        (yield* harness.call("stop_delegated_task", { taskId: taskId("busy") })).interrupted,
      ).toBe(true);
      const other = yield* harness
        .call("stop_delegated_task", { taskId: taskId("other") })
        .pipe(Effect.flip);
      expect(other).toMatchObject({ code: "unknown_task" });
      const send = yield* harness
        .call("send_to_delegated_task", { taskId: taskId("done"), message: "again" })
        .pipe(Effect.flip);
      expect(send).toMatchObject({ _tag: "McpCapabilityUnavailableError" });
      expect(harness.state.commands).toHaveLength(1);
    }),
  );
});

describe("list_models", () => {
  it.effect("lists providers, effort options and presets resolved to what they would run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("list_models", {});
      expect(result.providers.map((entry) => entry.provider)).toEqual(["codex", "claudeAgent"]);
      const sol = result.providers[0]!.models[0]!;
      expect(sol).toMatchObject({ model: "gpt-6.1-sol", name: "GPT-6.1-Sol" });
      expect(sol.options[0]!.values.map((value) => value.id)).toEqual([
        "low",
        "high",
        "xhigh",
        "ultra",
      ]);
      expect(result.presets).toEqual([
        {
          name: "実装役",
          available: true,
          provider: "codex",
          model: "gpt-6.1-sol",
          effort: "ultra",
        },
      ]);
      expect(result.maxConcurrentTasks).toBe(3);
    }),
  );
});

describe("delegate_task", () => {
  it.effect("starts a child in the same project and worktree on the preset's model", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("delegate_task", {
        prompt: "Implement the parser in src/parse.ts",
        preset: "実装役",
        title: "parser",
      });
      expect(result).toMatchObject({
        status: "running",
        threadTitle: "[委譲] parser",
        resolved: {
          provider: "codex",
          model: "gpt-6.1-sol",
          effort: "ultra",
          preset: "実装役",
        },
      });
      const [create, origin, started, turn] = harness.state.commands;
      expect(create).toMatchObject({
        type: "thread.create",
        threadId: result.taskId,
        projectId: PROJECT_ID,
        title: "[委譲] parser",
        branch: "feature/x",
        worktreePath: "/workspace/project-wt",
        // The parent asks before acting, so the child may not act freely.
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-6.1-sol",
          options: [{ id: "reasoningEffort", value: "ultra" }],
        },
      });
      expect(origin).toMatchObject({
        type: "thread.activity.append",
        threadId: result.taskId,
        activity: {
          kind: DELEGATION_ORIGIN_ACTIVITY_KIND,
          payload: { parentThreadId: PARENT_ID },
        },
      });
      expect(turn).toMatchObject({
        type: "thread.turn.start",
        threadId: result.taskId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      });
      const text = (turn as Extract<OrchestrationCommand, { type: "thread.turn.start" }>).message
        .text;
      expect(text.startsWith("Implement the parser in src/parse.ts\n")).toBe(true);
      expect(text).toContain('thread "Main thread"');
      expect(text).toContain("finish with a concise summary");
      expect(started).toMatchObject({
        type: "thread.activity.append",
        threadId: PARENT_ID,
        activity: {
          kind: DELEGATION_STARTED_ACTIVITY_KIND,
          payload: {
            childThreadId: result.taskId,
            title: "[委譲] parser",
            provider: "codex",
            model: "gpt-6.1-sol",
            effort: "ultra",
            presetName: "実装役",
          },
        },
      });
    }),
  );

  it.effect("resolves spoken provider, model and effort without a preset", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("delegate_task", {
        prompt: "Review the diff",
        model: "GPT 6.1 Sol",
        effort: "ウルトラ",
      });
      expect(result.resolved).toMatchObject({
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "ultra",
      });
      expect(result.threadTitle).toBe("[委譲] Review the diff");
    }),
  );

  it.effect("rejects an unknown model with the valid choices and starts nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("delegate_task", { prompt: "x", model: "gpt-9" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DelegationRejectedError",
        code: "unknown_model",
        candidates: expect.arrayContaining(["codex / gpt-6.1-sol (GPT-6.1-Sol)"]),
      });
      expect(harness.state.commands).toEqual([]);
    }),
  );

  it.effect("allows three running children and refuses a fourth until one finishes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => {
          adoptChild(state, "child-a", { latestTurn: turn("running") });
          adoptChild(state, "child-b", { latestTurn: turn("running") });
          adoptChild(state, "child-c", { latestTurn: turn("running") });
        },
      });
      const error = yield* harness
        .call("delegate_task", { prompt: "x", preset: "実装役" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DelegationRejectedError", code: "too_many_running" });
      expect(harness.state.commands).toEqual([]);

      harness.state.shells.set(
        taskId("child-b"),
        makeShell(taskId("child-b"), { latestTurn: turn("completed") }),
      );
      const result = yield* harness.call("delegate_task", { prompt: "x", preset: "実装役" });
      expect(result.status).toBe("running");
    }),
  );

  it.effect("counts parallel calls against the same limit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => {
          adoptChild(state, "child-a", { latestTurn: turn("running") });
          adoptChild(state, "child-b", { latestTurn: turn("running") });
        },
      });
      // The first created child has not started a turn yet, so it counts as running.
      const results = yield* Effect.all(
        [1, 2].map(() =>
          harness.call("delegate_task", { prompt: "x", preset: "実装役" }).pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      expect(results.filter((entry) => entry._tag === "Success")).toHaveLength(1);
    }),
  );
});

describe("delegated interaction mode and durable links", () => {
  it.effect("inherits the parent's plan mode for creation and follow-up turns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => {
          state.shells.set(PARENT_ID, makeShell(PARENT_ID, { interactionMode: "plan" }));
          adoptChild(state, "done", { latestTurn: turn("completed") });
        },
        onDispatch: (command, state) => {
          if (command.type !== "thread.turn.start" || command.threadId === taskId("done")) return;
          expect(
            state.activities
              .get(PARENT_ID)
              ?.some(
                (entry) =>
                  entry.kind === DELEGATION_STARTED_ACTIVITY_KIND &&
                  (entry.payload as { childThreadId: string }).childThreadId === command.threadId,
              ),
          ).toBe(true);
          expect(
            state.activities
              .get(command.threadId)
              ?.some((entry) => entry.kind === DELEGATION_ORIGIN_ACTIVITY_KIND),
          ).toBe(true);
        },
      });
      yield* harness.call("delegate_task", { prompt: "Plan the parser", preset: "実装役" });
      yield* harness.call("send_to_delegated_task", {
        taskId: taskId("done"),
        message: "Plan the next change",
      });
      const starts = harness.state.commands.filter(
        (command) => command.type === "thread.create" || command.type === "thread.turn.start",
      );
      expect(starts).toHaveLength(3);
      expect(starts.every((command) => command.interactionMode === "plan")).toBe(true);
    }),
  );

  it.effect("never starts an untracked child if recording the parent link fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        onDispatch: (command) => {
          if (
            command.type === "thread.activity.append" &&
            command.activity.kind === DELEGATION_STARTED_ACTIVITY_KIND
          ) {
            throw new Error("parent link failed");
          }
        },
      });
      const result = yield* harness
        .call("delegate_task", { prompt: "x", preset: "実装役" })
        .pipe(Effect.flip);
      expect(result).toMatchObject({ _tag: "DelegationFailedError" });
      expect(harness.state.commands.some((command) => command.type === "thread.turn.start")).toBe(
        false,
      );
      expect(harness.state.commands.at(-1)).toMatchObject({ type: "thread.delete" });
    }),
  );
});

describe("task ownership", () => {
  it.effect("treats an id the caller did not start as unknown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => {
          adoptChild(state, "theirs", {}, ThreadId.make("other-parent"));
          state.shells.set(taskId("plain"), makeShell(taskId("plain")));
        },
      });
      for (const id of ["theirs", "plain", "missing"]) {
        const error = yield* harness
          .call("wait_delegated_task", { taskId: taskId(id) })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DelegationRejectedError", code: "unknown_task" });
      }
      const stop = yield* harness
        .call("stop_delegated_task", { taskId: taskId("theirs") })
        .pipe(Effect.flip);
      expect(stop).toMatchObject({ code: "unknown_task" });
      const send = yield* harness
        .call("send_to_delegated_task", { taskId: taskId("theirs"), message: "hi" })
        .pipe(Effect.flip);
      expect(send).toMatchObject({ code: "unknown_task" });
      expect(harness.state.commands).toEqual([]);
    }),
  );
});

describe("wait_delegated_task", () => {
  it.effect("returns the child's final message once its turn completes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => {
          adoptChild(state, "child-a", { latestTurn: turn("running") });
          state.details.set(taskId("child-a"), {
            latestTurn: turn("completed", "m-2"),
            messages: [
              message("m-1", "user", "do it"),
              message("m-2", "assistant", "Done: parser added, tests pass."),
            ],
          });
        },
        // The event arrives after the handler saw the child running; the state it reads next is final.
        events: (state) =>
          Stream.fromEffect(
            Effect.sync(() => {
              state.shells.set(
                taskId("child-a"),
                makeShell(taskId("child-a"), {
                  title: "[委譲] child-a",
                  latestTurn: turn("completed", "m-2"),
                }),
              );
              return sessionEvent(taskId("child-a"));
            }),
          ),
      });
      const result = yield* harness.call("wait_delegated_task", { taskId: taskId("child-a") });
      expect(result).toMatchObject({
        taskId: "child-a",
        childThreadId: "child-a",
        status: "completed",
        finalMessage: "Done: parser added, tests pass.",
      });
    }),
  );

  it.effect("answers at once when the child already finished", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => {
          adoptChild(state, "child-a", { latestTurn: turn("error") });
          state.details.set(taskId("child-a"), { latestTurn: turn("error"), messages: [] });
        },
      });
      const result = yield* harness.call("wait_delegated_task", { taskId: taskId("child-a") });
      expect(result.status).toBe("error");
    }),
  );

  it.effect("reports needs_user_action instead of waiting on an approval", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) =>
          void adoptChild(state, "child-a", {
            latestTurn: turn("running"),
            hasPendingApprovals: true,
          }),
      });
      const result = yield* harness.call("wait_delegated_task", { taskId: taskId("child-a") });
      expect(result.status).toBe("needs_user_action");
      expect(result.hint).toContain("open that thread");
    }),
  );

  it.effect("returns running when the wait runs out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => void adoptChild(state, "child-a", { latestTurn: turn("running") }),
        events: () => Stream.never,
      });
      const waiting = yield* harness
        .call("wait_delegated_task", { taskId: taskId("child-a"), timeoutSeconds: 5 })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(5));
      const result = yield* Fiber.join(waiting);
      expect(result.status).toBe("running");
      expect(result.hint).toContain("again");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("delegated wait races", () => {
  it.effect("re-reads after subscription when completion happened in the subscription gap", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => void adoptChild(state, "child-a", { latestTurn: turn("running") }),
        onSubscribe: (state) =>
          state.shells.set(
            taskId("child-a"),
            makeShell(taskId("child-a"), { latestTurn: turn("completed") }),
          ),
        events: () => Stream.never,
      });
      expect(
        (yield* harness.call("wait_delegated_task", { taskId: taskId("child-a") })).status,
      ).toBe("completed");
    }),
  );

  it.effect("returns interrupted if the child disappears during subscription", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => void adoptChild(state, "child-a", { latestTurn: turn("running") }),
        onSubscribe: (state) => void state.shells.delete(taskId("child-a")),
        events: () => Stream.never,
      });
      expect(
        (yield* harness.call("wait_delegated_task", { taskId: taskId("child-a") })).status,
      ).toBe("interrupted");
    }),
  );

  it.effect("returns interrupted on deletion while already waiting", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => void adoptChild(state, "child-a", { latestTurn: turn("running") }),
        events: (state) =>
          Stream.fromEffect(
            Effect.sync(() => {
              state.shells.delete(taskId("child-a"));
              return {
                ...sessionEvent(taskId("child-a")),
                type: "thread.deleted",
              } as OrchestrationEvent;
            }),
          ).pipe(Stream.concat(Stream.never)),
      });
      const result = yield* harness.call("wait_delegated_task", { taskId: taskId("child-a") });
      expect(result).toMatchObject({
        status: "interrupted",
        hint: expect.stringContaining("deleted"),
      });
    }),
  );
});

describe("send_to_delegated_task and stop_delegated_task", () => {
  it.effect("sends a follow-up verbatim and reports the child as running again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => void adoptChild(state, "child-a", { latestTurn: turn("completed") }),
      });
      const result = yield* harness.call("send_to_delegated_task", {
        taskId: taskId("child-a"),
        message: "Also add a test.",
      });
      expect(harness.state.commands).toHaveLength(1);
      expect(harness.state.commands[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: "child-a",
        message: { text: "Also add a test." },
      });
      // The completed turn predates the follow-up, so its answer must not be reported again.
      expect(result.status).toBe("running");
      expect(result.finalMessage).toBeUndefined();
    }),
  );

  it.effect("will not wake a finished child while three others run", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => {
          adoptChild(state, "done", { latestTurn: turn("completed") });
          adoptChild(state, "r1", { latestTurn: turn("running") });
          adoptChild(state, "r2", { latestTurn: turn("running") });
          adoptChild(state, "r3", { latestTurn: turn("running") });
        },
      });
      const error = yield* harness
        .call("send_to_delegated_task", { taskId: taskId("done"), message: "again" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ code: "too_many_running" });
      expect(harness.state.commands).toEqual([]);
    }),
  );

  it.effect("interrupts the running turn and leaves a finished child alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => {
          adoptChild(state, "busy", { latestTurn: turn("running") });
          adoptChild(state, "done", { latestTurn: turn("completed") });
        },
      });
      const stopped = yield* harness.call("stop_delegated_task", { taskId: taskId("busy") });
      expect(stopped).toMatchObject({ interrupted: true, status: "running" });
      expect(harness.state.commands).toMatchObject([
        { type: "thread.turn.interrupt", threadId: "busy", turnId: "turn-1" },
      ]);
      const idle = yield* harness.call("stop_delegated_task", { taskId: taskId("done") });
      expect(idle).toMatchObject({ interrupted: false, status: "completed" });
      expect(harness.state.commands).toHaveLength(1);
    }),
  );
});

describe("follow-up rejection while running", () => {
  it.effect("rejects running and user-blocked children without adding a user message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => {
          adoptChild(state, "busy", { latestTurn: turn("running") });
          adoptChild(state, "blocked", { latestTurn: turn("running"), hasPendingApprovals: true });
        },
      });
      for (const id of ["busy", "blocked"]) {
        const result = yield* harness
          .call("send_to_delegated_task", { taskId: taskId(id), message: "again" })
          .pipe(Effect.flip);
        expect(result).toMatchObject({ code: "task_running" });
      }
      expect(harness.state.commands).toEqual([]);
      harness.state.shells.set(
        taskId("busy"),
        makeShell(taskId("busy"), { latestTurn: turn("completed") }),
      );
      expect((yield* harness.call("wait_delegated_task", { taskId: taskId("busy") })).status).toBe(
        "completed",
      );
    }),
  );

  it.effect("serializes simultaneous follow-ups and refuses the second queued turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        setup: (state) => void adoptChild(state, "done", { latestTurn: turn("completed") }),
      });
      const results = yield* Effect.all(
        [1, 2].map(() =>
          harness
            .call("send_to_delegated_task", { taskId: taskId("done"), message: "again" })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(harness.state.commands).toHaveLength(1);
    }),
  );
});

function message(id: string, role: "user" | "assistant", text: string) {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: TurnId.make("turn-1"),
    streaming: false,
    createdAt: T1,
    updatedAt: T1,
  } as const;
}

describe("deriveDelegatedTaskStatus", () => {
  const base = {
    latestTurn: null,
    session: null,
    latestUserMessageAt: T0,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  } as const;

  it("maps the latest turn's state", () => {
    expect(deriveDelegatedTaskStatus({ ...base, latestTurn: turn("completed") })).toBe("completed");
    expect(deriveDelegatedTaskStatus({ ...base, latestTurn: turn("interrupted") })).toBe(
      "interrupted",
    );
    expect(deriveDelegatedTaskStatus({ ...base, latestTurn: turn("error") })).toBe("error");
    expect(deriveDelegatedTaskStatus({ ...base, latestTurn: turn("running") })).toBe("running");
  });

  it("treats a thread that has not started its first turn as running", () => {
    expect(deriveDelegatedTaskStatus(base)).toBe("running");
  });

  it("reports a pending approval or question ahead of the turn state", () => {
    expect(
      deriveDelegatedTaskStatus({
        ...base,
        latestTurn: turn("running"),
        hasPendingUserInput: true,
      }),
    ).toBe("needs_user_action");
  });

  it("does not report a finished turn when a newer message is waiting", () => {
    expect(
      deriveDelegatedTaskStatus({
        ...base,
        latestTurn: turn("completed"),
        latestUserMessageAt: "2026-10-01T00:05:00.000Z",
      }),
    ).toBe("running");
  });

  it("treats a stopped session as interrupted even before its queued turn starts", () => {
    expect(
      deriveDelegatedTaskStatus({
        ...base,
        latestUserMessageAt: T1,
        session: {
          threadId: PARENT_ID,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: T2,
        },
      }),
    ).toBe("interrupted");
    expect(
      deriveDelegatedTaskStatus({
        ...base,
        latestTurn: turn("running"),
        latestUserMessageAt: T1,
        hasPendingApprovals: true,
        session: {
          threadId: PARENT_ID,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: T2,
        },
      }),
    ).toBe("interrupted");
  });

  it("reports an error when the session failed after the queued message", () => {
    expect(
      deriveDelegatedTaskStatus({
        ...base,
        latestUserMessageAt: T1,
        session: {
          threadId: PARENT_ID,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "boom",
          updatedAt: T2,
        },
      }),
    ).toBe("error");
  });
});

describe("finalAssistantMessage", () => {
  it("prefers the latest turn's assistant message and skips empty ones", () => {
    expect(
      finalAssistantMessage({
        latestTurn: turn("completed", "m-3"),
        messages: [
          message("m-1", "assistant", "first"),
          message("m-3", "assistant", "final"),
          message("m-4", "assistant", "   "),
        ],
      }),
    ).toBe("final");
    expect(
      finalAssistantMessage({
        latestTurn: null,
        messages: [message("m-1", "user", "hi"), message("m-2", "assistant", "only answer")],
      }),
    ).toBe("only answer");
    expect(finalAssistantMessage({ latestTurn: null, messages: [] })).toBeUndefined();
  });
});
