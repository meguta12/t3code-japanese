import {
  CommandId,
  DELEGATION_ORIGIN_ACTIVITY_KIND,
  DELEGATION_STARTED_ACTIVITY_KIND,
  DelegationOriginPayload,
  DelegationStartedPayload,
  delegationOriginActivityId,
  delegationStartedActivityId,
  EventId,
  MAX_CONCURRENT_DELEGATED_TASKS,
  McpCapabilityUnavailableError,
  MessageId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  catalogFromProviders,
  resolveDelegationTarget,
  type DelegationTargetInput,
} from "./resolveTarget.ts";
import {
  DEFAULT_WAIT_SECONDS,
  DelegationFailedError,
  DelegationRejectedError,
  DelegationToolkit,
  MAX_WAIT_SECONDS,
  type DelegatedTaskStateResult,
  type DelegatedTaskStatus,
  type ListModelsResult,
} from "./tools.ts";

const decodeOrigin = Schema.decodeUnknownOption(DelegationOriginPayload);
const decodeStarted = Schema.decodeUnknownOption(DelegationStartedPayload);

const MAX_FINAL_MESSAGE_CHARS = 20_000;
const MAX_TITLE_CHARS = 60;

/**
 * What a delegated thread is doing, read from the child thread's own state so
 * the parent's link never has to be updated. A message newer than the latest
 * turn means a turn is queued but has not started, so the old turn's result
 * must not be reported as the answer.
 */
export function deriveDelegatedTaskStatus(
  shell: Pick<
    OrchestrationThreadShell,
    "latestTurn" | "session" | "latestUserMessageAt" | "hasPendingApprovals" | "hasPendingUserInput"
  >,
): DelegatedTaskStatus {
  if (
    shell.session?.status === "stopped" &&
    (shell.latestUserMessageAt === null || shell.session.updatedAt >= shell.latestUserMessageAt) &&
    (shell.hasPendingApprovals ||
      shell.hasPendingUserInput ||
      shell.latestTurn?.state === "running")
  )
    return "interrupted";
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "needs_user_action";
  const turn = shell.latestTurn;
  const queuedAt = shell.latestUserMessageAt;
  if (queuedAt !== null && (turn === null || queuedAt > turn.requestedAt)) {
    const session = shell.session;
    if (session && session.updatedAt >= queuedAt) {
      if (session.status === "error") return "error";
      if (session.status === "stopped") return "interrupted";
    }
    return "running";
  }
  if (turn === null) {
    if (shell.session?.status === "error") return "error";
    if (shell.session?.status === "stopped") return "interrupted";
    return "running";
  }
  if (turn.state === "running" && shell.session?.status === "stopped") return "interrupted";
  return turn.state;
}

/** The child's answer: its latest turn's last assistant message, falling back to the last one overall. */
export function finalAssistantMessage(
  thread: Pick<OrchestrationThread, "messages" | "latestTurn">,
): string | undefined {
  const assistant = thread.messages.filter(
    (message) => message.role === "assistant" && message.text.trim().length > 0,
  );
  const latest = thread.latestTurn;
  const chosen =
    (latest?.assistantMessageId
      ? assistant.find((message) => message.id === latest.assistantMessageId)
      : undefined) ??
    assistant.findLast((message) => latest !== null && message.turnId === latest.turnId) ??
    assistant.at(-1);
  if (!chosen) return undefined;
  return chosen.text.length > MAX_FINAL_MESSAGE_CHARS
    ? `${chosen.text.slice(0, MAX_FINAL_MESSAGE_CHARS)}\n[truncated: open the child thread for the full text]`
    : chosen.text;
}

const firstLine = (text: string) => text.trim().split(/\r?\n/, 1)[0]!.trim();

const childTitle = (input: { readonly title?: string | undefined; readonly prompt: string }) => {
  const base = firstLine(input.title ?? input.prompt);
  const short = base.length > MAX_TITLE_CHARS ? `${base.slice(0, MAX_TITLE_CHARS - 1)}…` : base;
  return `[委譲] ${short}`;
};

const withFooter = (prompt: string, parent: { readonly id: ThreadId; readonly title: string }) =>
  `${prompt}\n\n---\n[Delegated by the agent in T3 Code thread "${parent.title}" (${parent.id}), working in the same project directory. That agent reads only your final message, so finish with a concise summary: what you did, what changed, and anything unresolved.]`;

/** Events worth re-reading the child's state for; message deltas are far more frequent and never settle a turn. */
const settlesOrBlocks = (event: { readonly type: string; readonly payload: unknown }) => {
  if (
    event.type === "thread.session-set" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.turn-interrupt-requested" ||
    event.type === "thread.deleted"
  ) {
    return true;
  }
  if (event.type !== "thread.activity-appended") return false;
  const kind = (event.payload as { activity?: { kind?: unknown } }).activity?.kind;
  return kind === "approval.requested" || kind === "user-input.requested";
};

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  // Parallel delegate_task calls must see each other's links before counting.
  const startGate = yield* Semaphore.make(1);

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string, threadId: ThreadId) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${threadId}:${id}`)));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const reject = (
    code: DelegationRejectedError["code"],
    detail: string,
    candidates: string[] = [],
  ) => new DelegationRejectedError({ code, detail, candidates });

  /** Infrastructure failures become one declared error; interrupts pass through untouched. */
  const failed =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, DelegationFailedError, R> =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(new DelegationFailedError({ operation, cause })),
        ),
      );

  const readShell = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(failed("read thread"));

  const originOf = (threadId: ThreadId) =>
    snapshots.listThreadActivitiesByKinds(threadId, [DELEGATION_ORIGIN_ACTIVITY_KIND]).pipe(
      failed("read delegation link"),
      Effect.map(
        (activities) =>
          activities
            .toReversed()
            .flatMap((activity) => Option.toArray(decodeOrigin(activity.payload)))
            .at(0)?.parentThreadId,
      ),
    );

  /**
   * The calling thread, once the setting and the no-nesting rule allow delegating.
   * Both are read live rather than from the session's credential, so turning
   * delegation on applies to agents that are already running.
   */
  const requireParent = Effect.fn("DelegationToolkit.requireParent")(function* (
    allowExistingTask = false,
  ) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const settings = yield* serverSettings.getSettings.pipe(failed("read settings"));
    if (!allowExistingTask && !settings.enableAgentDelegation) {
      return yield* new McpCapabilityUnavailableError({
        capability: "delegation",
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        providerSessionId: scope.providerSessionId,
        providerInstanceId: scope.providerInstanceId,
      });
    }
    const shell = yield* readShell(scope.threadId);
    if (Option.isNone(shell)) {
      return yield* reject("thread_not_found", `Thread ${scope.threadId} was not found.`);
    }
    if ((yield* originOf(scope.threadId)) !== undefined) {
      return yield* reject(
        "nested_delegation",
        "This thread was itself delegated. Do the work here and report back; do not delegate further.",
      );
    }
    return { scope, parent: shell.value, settings };
  });

  const childrenOf = (parentId: ThreadId) =>
    snapshots.listThreadActivitiesByKinds(parentId, [DELEGATION_STARTED_ACTIVITY_KIND]).pipe(
      failed("read delegation links"),
      Effect.map((activities) => [
        ...new Set(
          activities.flatMap((activity) =>
            Option.toArray(decodeStarted(activity.payload)).map((entry) => entry.childThreadId),
          ),
        ),
      ]),
    );

  const activeChildren = Effect.fn("DelegationToolkit.activeChildren")(function* (
    parentId: ThreadId,
    except?: ThreadId,
  ) {
    const active: string[] = [];
    for (const childId of yield* childrenOf(parentId)) {
      if (childId === except) continue;
      const shell = yield* readShell(childId);
      if (Option.isNone(shell)) continue;
      const status = deriveDelegatedTaskStatus(shell.value);
      if (status === "running" || status === "needs_user_action") {
        active.push(`${shell.value.title} (${childId})`);
      }
    }
    return active;
  });

  const requireOwnedChild = Effect.fn("DelegationToolkit.requireOwnedChild")(function* (
    parentId: ThreadId,
    taskId: ThreadId,
  ) {
    const unknown = () =>
      reject(
        "unknown_task",
        `No delegated task ${taskId} was started from this thread. Use the taskId returned by delegate_task.`,
      );
    if ((yield* originOf(taskId)) !== parentId) return yield* unknown();
    const shell = yield* readShell(taskId);
    if (Option.isNone(shell)) return yield* unknown();
    return shell.value;
  });

  const stateOf = Effect.fn("DelegationToolkit.stateOf")(function* (
    shell: OrchestrationThreadShell,
  ) {
    const status = deriveDelegatedTaskStatus(shell);
    const finalMessage =
      status === "running" || status === "needs_user_action"
        ? undefined
        : yield* snapshots.getThreadDetailById(shell.id).pipe(
            failed("read result"),
            Effect.map((thread) =>
              Option.isSome(thread) ? finalAssistantMessage(thread.value) : undefined,
            ),
          );
    const hint =
      status === "needs_user_action"
        ? `The child thread "${shell.title}" is waiting for an approval or an answer that only the user can give. Ask the user to open that thread.`
        : status === "running"
          ? "Still running. Call wait_delegated_task again."
          : status === "error"
            ? `The child failed${shell.session?.lastError ? `: ${shell.session.lastError}` : "."} Report this to the user.`
            : undefined;
    return {
      taskId: shell.id,
      childThreadId: shell.id,
      title: shell.title,
      status,
      ...(finalMessage === undefined ? {} : { finalMessage }),
      ...(hint === undefined ? {} : { hint }),
    } satisfies DelegatedTaskStateResult;
  });

  const waitFor = Effect.fn("DelegationToolkit.waitFor")(function* (
    shell: OrchestrationThreadShell,
    seconds: number,
  ) {
    const childId = shell.id;
    const removed = () => ({
      taskId: childId,
      childThreadId: childId,
      title: shell.title,
      status: "interrupted" as const,
      hint: "The delegated child thread was deleted.",
    });
    // Subscribe, then re-read: the caller's snapshot may predate the subscription.
    const events = yield* engine.subscribeDomainEvents;
    const current = yield* readShell(childId);
    if (Option.isNone(current)) return removed();
    if (deriveDelegatedTaskStatus(current.value) !== "running") {
      return yield* stateOf(current.value);
    }
    yield* events.pipe(
      Stream.filter(
        (event) =>
          event.aggregateKind === "thread" &&
          event.aggregateId === childId &&
          settlesOrBlocks(event),
      ),
      Stream.mapEffect(() => readShell(childId)),
      Stream.filter(
        (latest) => Option.isNone(latest) || deriveDelegatedTaskStatus(latest.value) !== "running",
      ),
      Stream.runHead,
      failed("wait"),
      Effect.timeoutOption(Duration.seconds(seconds)),
    );
    const latest = yield* readShell(childId);
    return Option.isNone(latest) ? removed() : yield* stateOf(latest.value);
  }, Effect.scoped);

  const sendTurn = Effect.fn("DelegationToolkit.sendTurn")(function* (
    input: Omit<
      Extract<
        Parameters<OrchestrationEngine.OrchestrationEngineShape["dispatch"]>[0],
        { type: "thread.turn.start" }
      >,
      "type" | "commandId" | "createdAt" | "message" | "attachments"
    > & { readonly text: string },
  ) {
    const { text, ...rest } = input;
    return yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: yield* commandId("mcp-delegation-turn", input.threadId),
      message: {
        messageId: MessageId.make(yield* uuid),
        role: "user",
        text,
        attachments: [],
      },
      createdAt: yield* nowIso,
      ...rest,
    });
  });

  return DelegationToolkit.of({
    list_models: () =>
      Effect.gen(function* () {
        const { settings } = yield* requireParent();
        const catalog = catalogFromProviders(yield* registry.getProviders);
        const presets = settings.delegationPresets;
        return {
          providers: catalog.map((provider) => ({
            provider: provider.instanceId,
            name: provider.displayName,
            ready: provider.ready,
            ...(provider.notReadyReason ? { notReadyReason: provider.notReadyReason } : {}),
            models: provider.models.map((model) => ({
              model: model.slug,
              name: model.name,
              aliases: [...model.aliases],
              isDefault: model.isDefault,
              options: model.optionDescriptors.map((descriptor) => ({
                id: descriptor.id,
                label: descriptor.label,
                kind: descriptor.type,
                values:
                  descriptor.type === "select"
                    ? descriptor.options.map((option) => ({
                        id: option.id,
                        label: option.label,
                        isDefault: option.isDefault === true,
                      }))
                    : [],
              })),
            })),
          })),
          presets: presets.map((preset) => {
            const resolved = resolveDelegationTarget({
              catalog,
              presets,
              request: { preset: preset.id },
            });
            return resolved.ok
              ? {
                  name: preset.name,
                  available: true,
                  provider: resolved.target.provider,
                  model: resolved.target.model,
                  effort: resolved.target.effort,
                }
              : {
                  name: preset.name,
                  available: false,
                  provider: preset.modelSelection.instanceId,
                  model: preset.modelSelection.model,
                  effort: null,
                  problem: resolved.error.message,
                };
          }),
          maxConcurrentTasks: MAX_CONCURRENT_DELEGATED_TASKS,
        } satisfies ListModelsResult;
      }),

    delegate_task: (input) =>
      Effect.gen(function* () {
        const { parent, settings } = yield* requireParent();
        const catalog = catalogFromProviders(yield* registry.getProviders);
        const request: DelegationTargetInput = {
          preset: input.preset,
          provider: input.provider,
          model: input.model,
          effort: input.effort,
        };
        const resolved = resolveDelegationTarget({
          catalog,
          presets: settings.delegationPresets,
          request,
          base: parent.modelSelection,
        });
        if (!resolved.ok) {
          return yield* reject(resolved.error.code, resolved.error.message, [
            ...resolved.error.candidates,
          ]);
        }
        const { target } = resolved;
        const title = childTitle(input);
        const childThreadId = ThreadId.make(yield* uuid);

        yield* startGate.withPermits(1)(
          Effect.gen(function* () {
            const active = yield* activeChildren(parent.id);
            if (active.length >= MAX_CONCURRENT_DELEGATED_TASKS) {
              return yield* reject(
                "too_many_running",
                `${active.length} delegated tasks are already running (limit ${MAX_CONCURRENT_DELEGATED_TASKS}). Wait for one with wait_delegated_task or stop one first: ${active.join("; ")}.`,
                active,
              );
            }
            const createdAt = yield* nowIso;
            yield* engine
              .dispatch({
                type: "thread.create",
                commandId: yield* commandId("mcp-delegation-create", childThreadId),
                threadId: childThreadId,
                projectId: parent.projectId,
                title,
                modelSelection: target.selection,
                // The caller's own mode: a child never gets more freedom than its parent has.
                runtimeMode: parent.runtimeMode,
                interactionMode: parent.interactionMode,
                branch: parent.branch,
                worktreePath: parent.worktreePath,
                createdAt,
              })
              .pipe(failed("create thread"));
            yield* Effect.gen(function* () {
              yield* engine.dispatch({
                type: "thread.activity.append",
                commandId: yield* commandId("mcp-delegation-origin", childThreadId),
                threadId: childThreadId,
                activity: {
                  id: EventId.make(delegationOriginActivityId(childThreadId)),
                  tone: "info",
                  kind: DELEGATION_ORIGIN_ACTIVITY_KIND,
                  summary: "Delegated from another thread",
                  payload: { parentThreadId: parent.id } satisfies DelegationOriginPayload,
                  turnId: null,
                  createdAt,
                },
                createdAt,
              });
              yield* engine.dispatch({
                type: "thread.activity.append",
                commandId: yield* commandId("mcp-delegation-started", parent.id),
                threadId: parent.id,
                activity: {
                  id: EventId.make(delegationStartedActivityId(childThreadId)),
                  tone: "info",
                  kind: DELEGATION_STARTED_ACTIVITY_KIND,
                  summary: "Delegated a task",
                  payload: {
                    childThreadId,
                    title,
                    provider: target.provider,
                    model: target.model,
                    effort: target.effort,
                    ...(target.presetName ? { presetName: target.presetName } : {}),
                    createdAt,
                  } satisfies DelegationStartedPayload,
                  turnId: null,
                  createdAt,
                },
                createdAt,
              });
              yield* sendTurn({
                threadId: childThreadId,
                text: withFooter(input.prompt, parent),
                modelSelection: target.selection,
                runtimeMode: parent.runtimeMode,
                interactionMode: parent.interactionMode,
              });
            }).pipe(
              // A thread that never got its task or its link would be an orphan in the sidebar.
              Effect.onError(() =>
                commandId("mcp-delegation-cleanup", childThreadId).pipe(
                  Effect.flatMap((id) =>
                    engine.dispatch({
                      type: "thread.delete",
                      commandId: id,
                      threadId: childThreadId,
                    }),
                  ),
                  Effect.ignore,
                ),
              ),
              failed("start task"),
            );
          }),
        );

        return {
          taskId: childThreadId,
          threadTitle: title,
          resolved: {
            provider: target.provider,
            providerName: target.providerName,
            model: target.model,
            modelName: target.modelName,
            effort: target.effort,
            ...(target.presetName ? { preset: target.presetName } : {}),
          },
          status: "running" as const,
          notes: target.ignored.map(
            (name) => `${name} was ignored because the preset already fixes the target.`,
          ),
        };
      }),

    wait_delegated_task: (input) =>
      Effect.gen(function* () {
        const { parent } = yield* requireParent(true);
        const child = yield* requireOwnedChild(parent.id, input.taskId);
        const seconds = Math.min(input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
        return yield* waitFor(child, seconds);
      }),

    send_to_delegated_task: (input) =>
      Effect.gen(function* () {
        const { parent } = yield* requireParent();
        yield* startGate.withPermits(1)(
          Effect.gen(function* () {
            const child = yield* requireOwnedChild(parent.id, input.taskId);
            const status = deriveDelegatedTaskStatus(child);
            if (status === "running" || status === "needs_user_action") {
              return yield* reject(
                "task_running",
                "The delegated task is still running. Wait for it to finish or stop it before sending another instruction.",
              );
            }
            // A finished child that is woken up counts as running again.
            const active = yield* activeChildren(parent.id, child.id);
            if (active.length >= MAX_CONCURRENT_DELEGATED_TASKS) {
              return yield* reject(
                "too_many_running",
                `${active.length} delegated tasks are already running (limit ${MAX_CONCURRENT_DELEGATED_TASKS}). Wait for or stop one first: ${active.join("; ")}.`,
                active,
              );
            }
            yield* sendTurn({
              threadId: child.id,
              text: input.message,
              runtimeMode: child.runtimeMode,
              interactionMode: parent.interactionMode,
            }).pipe(failed("send message"));
          }),
        );
        const child = yield* requireOwnedChild(parent.id, input.taskId);
        return yield* stateOf(child);
      }),

    stop_delegated_task: (input) =>
      Effect.gen(function* () {
        const { parent } = yield* requireParent(true);
        const child = yield* requireOwnedChild(parent.id, input.taskId);
        const status = deriveDelegatedTaskStatus(child);
        if (status !== "running" && status !== "needs_user_action") {
          return { taskId: child.id, interrupted: false, status };
        }
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: yield* commandId("mcp-delegation-stop", child.id),
            threadId: child.id,
            ...(child.latestTurn?.state === "running" ? { turnId: child.latestTurn.turnId } : {}),
            createdAt: yield* nowIso,
          })
          .pipe(failed("interrupt"));
        return { taskId: child.id, interrupted: true, status };
      }),
  });
});

export const DelegationToolkitHandlersLive = DelegationToolkit.toLayer(make);
