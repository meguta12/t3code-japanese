/** Translates OpenCode 2 sessions into the existing T3 runtime events. */
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import type {
  OpenCodeClient,
  OpenCodeEvent,
  FormInfo,
  PermissionRequest,
  SessionInfo,
} from "@opencode/client";
import {
  EventId,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ModelSelection,
  type OpenCodeSettings,
  type ProviderSession,
  type ThreadId,
  type RuntimeMode,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { openCodeRuntimeErrorDetail, parseOpenCodeModelSlug } from "../opencodeRuntime.ts";
import {
  openCode2Request,
  type OpenCode2Connection,
  type OpenCode2Runtime,
} from "../OpenCode2Runtime.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("opencode");
const nativeError = (method: string, cause: unknown) =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: openCodeRuntimeErrorDetail(cause),
    cause,
  });
const request = <A>(method: string, run: (signal: AbortSignal) => Promise<A>) =>
  openCode2Request(method, run).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) => nativeError(method, cause)),
  );
const mcpName = (thread: string) => `t3-code-${thread.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
type Rules = NonNullable<Parameters<OpenCodeClient["session"]["update"]>[0]["permissions"]>;

/** Session-scoped approvals never widen another thread's permissions. Last rule wins. */
export function openCode2Rules(
  mode: RuntimeMode,
  thread: string,
  plan: boolean,
  grants: Rules = [],
): Rules {
  return [
    ...(mode === "full-access"
      ? [{ action: "*", resource: "*", effect: "allow" as const }]
      : [
          { action: "shell", resource: "*", effect: "ask" as const },
          {
            action: "edit",
            resource: "*",
            effect: mode === "auto-accept-edits" ? ("allow" as const) : ("ask" as const),
          },
          { action: "external_directory", resource: "*", effect: "ask" as const },
          { action: "read", resource: "*.env*", effect: "ask" as const },
          { action: "read", resource: "*.env.example", effect: "allow" as const },
        ]),
    ...grants,
    ...(plan ? [{ action: "edit", resource: "*", effect: "deny" as const }] : []),
    { action: "t3-code-*", resource: "*", effect: "deny" },
    { action: `${mcpName(thread)}_*`, resource: "*", effect: "allow" },
  ];
}

export function openCode2Model(selection: ModelSelection | undefined) {
  const parsed = selection && parseOpenCodeModelSlug(selection.model);
  if (!parsed) throw new Error("Choose an OpenCode model in provider/model format.");
  const variant = getModelSelectionStringOptionValue(selection!, "variant");
  return { id: parsed.modelID, providerID: parsed.providerID, ...(variant ? { variant } : {}) };
}

interface Context {
  session: ProviderSession;
  native: SessionInfo;
  client: OpenCodeClient;
  active?: TurnId;
  modelSelection?: ModelSelection;
  plan: boolean;
  stopped: boolean;
  grants: Rules;
  mcp?: { name: string; directory: string; credential: string };
  permissions: Map<string, PermissionRequest>;
  forms: Map<string, FormInfo>;
  items: Map<
    string,
    { type: "assistant_message" | "reasoning" | "dynamic_tool_call"; text: string; name?: string }
  >;
  turns: Array<{ id: TurnId; items: unknown[] }>;
  lock: Semaphore.Semaphore;
}

export const makeOpenCode2Adapter = Effect.fn("makeOpenCode2Adapter")(function* (
  _settings: OpenCodeSettings,
  runtime: OpenCode2Runtime,
) {
  const serverConfig = yield* ServerConfig;
  const scope = yield* Effect.scope;
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, Context>();
  const nativeSessions = new Map<string, Context>();
  const seen = new Set<string>();
  let pump: Fiber.Fiber<void, never> | undefined;
  let pumpFailure: unknown;
  const eventLock = yield* Semaphore.make(1);
  const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

  const emit = <K extends ProviderRuntimeEvent["type"]>(
    context: Context,
    type: K,
    payload: Extract<ProviderRuntimeEvent, { type: K }>["payload"],
    extra: { itemId?: RuntimeItemId; requestId?: RuntimeRequestId; turnId?: TurnId } = {},
  ) =>
    Effect.gen(function* () {
      yield* Queue.offer(
        events,
        decodeEvent({
          eventId: EventId.make(NodeCrypto.randomUUID()),
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          type,
          payload,
          ...(context.active ? { turnId: context.active } : {}),
          providerRefs: { providerSessionId: context.native.id },
          ...extra,
        }),
      );
    });
  const get = (id: ThreadId) =>
    Effect.suspend(() => {
      const found = sessions.get(id);
      return found && !found.stopped
        ? Effect.succeed(found)
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId: id }),
          );
    });
  const finish = (
    context: Context,
    state: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) =>
    Effect.gen(function* () {
      if (!context.active) return;
      for (const [id, item] of context.items) {
        yield* emit(
          context,
          "item.completed",
          {
            itemType: item.type,
            status: state === "failed" ? "failed" : "completed",
            ...(item.text ? { detail: item.text } : {}),
          },
          { itemId: RuntimeItemId.make(id) },
        );
      }
      context.items.clear();
      yield* emit(context, "turn.completed", { state, ...(errorMessage ? { errorMessage } : {}) });
      delete context.active;
      const { activeTurnId: _active, ...session } = context.session;
      context.session = {
        ...session,
        status: "ready",
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      for (const [id] of context.permissions)
        yield* emit(
          context,
          "request.resolved",
          { requestType: "permission_approval", decision: "cancel" },
          { requestId: RuntimeRequestId.make(id) },
        );
      context.permissions.clear();
      for (const [id] of context.forms)
        yield* emit(
          context,
          "user-input.resolved",
          { answers: {} },
          { requestId: RuntimeRequestId.make(id) },
        );
      context.forms.clear();
    });

  const permission = (context: Context, native: PermissionRequest) =>
    Effect.gen(function* () {
      if (context.permissions.has(native.id)) return;
      if (context.session.runtimeMode === "full-access") {
        yield* request("permission.reply", (signal) =>
          context.client.permission.reply(
            { sessionID: native.sessionID, requestID: native.id, decision: "once" },
            { signal },
          ),
        );
        return;
      }
      context.permissions.set(native.id, native);
      yield* emit(
        context,
        "request.opened",
        {
          requestType:
            native.action === "shell"
              ? "command_execution_approval"
              : native.action === "edit"
                ? "file_change_approval"
                : "permission_approval",
          detail: native.message || `${native.action}: ${native.resources.join(", ")}`,
          args: { action: native.action, resources: native.resources, metadata: native.metadata },
          options: [
            { decision: "accept", label: "Allow once" },
            { decision: "acceptForSession", label: "Allow for this session" },
            { decision: "decline", label: "Deny" },
          ],
        },
        { requestId: RuntimeRequestId.make(native.id) },
      );
    });
  const form = (context: Context, native: FormInfo) =>
    Effect.gen(function* () {
      if (context.forms.has(native.id)) return;
      const unsupported = native.fields.some(
        (field) =>
          (field.type !== "string" && field.type !== "multiselect") ||
          field.hidden ||
          (field.when?.length ?? 0) > 0,
      );
      if (unsupported) {
        yield* request("form.cancel", (signal) =>
          context.client.session.form.cancel(
            {
              sessionID: native.sessionID,
              formID: native.id,
              message:
                "This form needs field types the T3 client cannot display. Ask a plain-text question instead.",
            },
            { signal },
          ),
        );
        yield* emit(context, "runtime.error", {
          message:
            "OpenCode requested an unsupported form. It was cancelled; the agent can ask in plain text.",
        });
        return;
      }
      context.forms.set(native.id, native);
      yield* emit(
        context,
        "user-input.requested",
        {
          questions: native.fields.map((field) => ({
            id: field.key,
            header: field.title || native.title || "Question",
            question: field.description || field.title || native.title || "Question",
            options: (field.type === "string" || field.type === "multiselect"
              ? (field.options ?? [])
              : []
            ).map((option) => ({
              label: option.label || option.value,
              description: option.description || option.label || option.value,
            })),
            allowCustomAnswer:
              (field.type === "string" || field.type === "multiselect") &&
              (field.custom === true || !field.options?.length),
            multiSelect: field.type === "multiselect",
          })),
        },
        { requestId: RuntimeRequestId.make(native.id) },
      );
    });

  const onEvent = (event: OpenCodeEvent) =>
    Effect.gen(function* () {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      if (seen.size > 4000) seen.delete(seen.values().next().value!);
      if (event.type === "session.created" && event.data.parentID) {
        const parent = nativeSessions.get(event.data.parentID);
        if (parent) nativeSessions.set(event.data.sessionID, parent);
      }
      const sessionID =
        "sessionID" in event.data
          ? event.data.sessionID
          : event.type === "form.created"
            ? event.data.form.sessionID
            : undefined;
      if (typeof sessionID !== "string") return;
      const context = nativeSessions.get(sessionID);
      if (!context || context.stopped) return;
      if (event.type === "permission.asked") return yield* permission(context, event.data);
      if (event.type === "form.created") return yield* form(context, event.data.form);
      if (event.type === "permission.replied") {
        if (context.permissions.delete(event.data.requestID))
          yield* emit(
            context,
            "request.resolved",
            { requestType: "permission_approval", decision: event.data.reply },
            { requestId: RuntimeRequestId.make(event.data.requestID) },
          );
        return;
      }
      if (event.type === "form.replied" || event.type === "form.cancelled") {
        if (context.forms.delete(event.data.id))
          yield* emit(
            context,
            "user-input.resolved",
            { answers: {} },
            { requestId: RuntimeRequestId.make(event.data.id) },
          );
        return;
      }
      if (!context.active) return;
      // A child session's terminal must never finish its parent's turn.
      if (sessionID === context.native.id) {
        if (event.type === "session.execution.succeeded")
          return yield* finish(context, "completed");
        if (event.type === "session.execution.interrupted")
          return yield* finish(context, "interrupted");
        if (event.type === "session.execution.failed")
          return yield* finish(context, "failed", event.data.error.message);
      }
      switch (event.type) {
        case "session.text.started":
        case "session.reasoning.started":
        case "session.text.delta":
        case "session.reasoning.delta":
        case "session.text.ended":
        case "session.reasoning.ended": {
          const kind = event.type.startsWith("session.text.") ? "assistant_message" : "reasoning";
          const id = `${event.data.assistantMessageID}:${kind}:${event.data.ordinal}`;
          let item = context.items.get(id);
          if (!item) {
            item = { type: kind, text: "" };
            context.items.set(id, item);
            yield* emit(
              context,
              "item.started",
              { itemType: kind, status: "inProgress" },
              { itemId: RuntimeItemId.make(id) },
            );
          }
          if ("delta" in event.data && event.data.delta) {
            item.text += event.data.delta;
            yield* emit(
              context,
              "content.delta",
              {
                streamKind: kind === "assistant_message" ? "assistant_text" : "reasoning_text",
                delta: event.data.delta,
              },
              { itemId: RuntimeItemId.make(id) },
            );
          }
          if (event.type.endsWith(".ended")) {
            if ("text" in event.data && event.data.text.startsWith(item.text)) {
              const missing = event.data.text.slice(item.text.length);
              if (missing)
                yield* emit(
                  context,
                  "content.delta",
                  {
                    streamKind: kind === "assistant_message" ? "assistant_text" : "reasoning_text",
                    delta: missing,
                  },
                  { itemId: RuntimeItemId.make(id) },
                );
              item.text = event.data.text;
            }
            yield* emit(
              context,
              "item.completed",
              { itemType: kind, status: "completed", ...(item.text ? { detail: item.text } : {}) },
              { itemId: RuntimeItemId.make(id) },
            );
            context.items.delete(id);
          }
          return;
        }
        case "session.tool.input.started": {
          context.items.set(event.data.id, {
            type: "dynamic_tool_call",
            text: "",
            name: event.data.name,
          });
          yield* emit(
            context,
            "item.started",
            { itemType: "dynamic_tool_call", status: "inProgress", title: event.data.name },
            { itemId: RuntimeItemId.make(event.data.id) },
          );
          return;
        }
        case "session.tool.called":
          yield* emit(
            context,
            "item.updated",
            {
              itemType: "dynamic_tool_call",
              status: "inProgress",
              data: { input: event.data.input },
            },
            { itemId: RuntimeItemId.make(event.data.id) },
          );
          return;
        case "session.tool.success":
        case "session.tool.failed": {
          const output =
            event.type === "session.tool.failed"
              ? event.data.error.message
              : event.data.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("\n");
          yield* emit(
            context,
            "item.completed",
            {
              itemType: "dynamic_tool_call",
              status: event.type === "session.tool.failed" ? "failed" : "completed",
              ...(output ? { detail: output } : {}),
            },
            { itemId: RuntimeItemId.make(event.data.id) },
          );
          context.items.delete(event.data.id);
          return;
        }
        case "session.step.ended":
        case "session.step.failed": {
          const tokens = event.data.tokens;
          if (tokens)
            yield* emit(context, "thread.token-usage.updated", {
              usage: {
                inputTokens: tokens.input,
                outputTokens: tokens.output,
                cachedInputTokens: tokens.cache.read,
                reasoningOutputTokens: tokens.reasoning,
                usedTokens: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output,
              },
            });
          return;
        }
      }
    });

  const ensureEvents = (connection: OpenCode2Connection) =>
    Effect.gen(function* () {
      if (pumpFailure) return yield* nativeError("event.subscribe", pumpFailure);
      if (pump) return;
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      pump = yield* connection.events(controller.signal).pipe(
        Stream.runForEach((event) => onEvent(event).pipe(eventLock.withPermits(1))),
        Effect.andThen(Effect.fail(new Error("OpenCode closed its event stream."))),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            pumpFailure = cause;
            for (const context of sessions.values())
              yield* finish(
                context,
                "failed",
                "The OpenCode event connection was lost. Reconnect this thread before retrying.",
              );
          }),
        ),
        Effect.forkIn(scope),
      );
      yield* connection.subscribed.pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) => nativeError("event.subscribe", cause)),
      );
    }).pipe(Scope.provide(scope));

  const setup = (context: Context) =>
    Effect.gen(function* () {
      const mcp = McpProviderSession.readMcpProviderSession(context.session.threadId);
      if (mcp) {
        const directory = context.session.cwd ?? serverConfig.cwd;
        if (!context.mcp || context.mcp.credential !== mcp.authorizationHeader) {
          const name = mcpName(context.session.threadId);
          yield* request("mcp.add", (signal) =>
            context.client.mcp.add(
              {
                server: name,
                location: { directory },
                config: {
                  type: "remote",
                  url: mcp.endpoint,
                  headers: { Authorization: mcp.authorizationHeader },
                  oauth: false,
                },
              },
              { signal },
            ),
          );
          context.mcp = { name, directory, credential: mcp.authorizationHeader };
        }
        if (mcp.agentDeviceEnvironment)
          yield* request("session.environment", (signal) =>
            context.client.session.environment(
              { sessionID: context.native.id, variables: mcp.agentDeviceEnvironment! },
              { signal },
            ),
          );
      }
      yield* request("session.instructions", (signal) =>
        context.client.session.instructions.entry.put(
          {
            sessionID: context.native.id,
            key: "t3-code",
            value: buildRuntimeInstructions({ harness: "OpenCode", model: context.session.model }),
          },
          { signal },
        ),
      );
    });

  const startSession: OpenCodeAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        if (existing.session.runtimeMode !== input.runtimeMode) {
          yield* request("session.permissions", (signal) =>
            existing.client.session.update(
              {
                sessionID: existing.native.id,
                permissions: openCode2Rules(input.runtimeMode, input.threadId, existing.plan),
              },
              { signal },
            ),
          );
          existing.grants = [];
          existing.session = { ...existing.session, runtimeMode: input.runtimeMode };
        }
        return existing.session;
      }
      const connection = yield* runtime.connection.pipe(
        Effect.mapError((cause) => nativeError("connect", cause)),
      );
      yield* ensureEvents(connection);
      const cursor = input.resumeCursor;
      const nativeID =
        typeof cursor === "object" &&
        cursor !== null &&
        "openCode2SessionId" in cursor &&
        typeof cursor.openCode2SessionId === "string"
          ? cursor.openCode2SessionId
          : typeof cursor === "object" &&
              cursor !== null &&
              "sessionId" in cursor &&
              typeof cursor.sessionId === "string"
            ? cursor.sessionId
            : undefined;
      if (cursor !== undefined && cursor !== null && !nativeID)
        return yield* nativeError(
          "session.resume",
          new Error(
            "The saved OpenCode session cursor is invalid. It was not replaced with an empty conversation.",
          ),
        );
      const cwd = input.cwd ?? serverConfig.cwd;
      const model = yield* Effect.try({
        try: () => openCode2Model(input.modelSelection),
        catch: (cause) => nativeError("model", cause),
      });
      const native = nativeID
        ? yield* request("session.get", (signal) =>
            connection.client.session.get({ sessionID: nativeID }, { signal }),
          )
        : yield* request("session.create", (signal) =>
            connection.client.session.create(
              {
                title: input.title || "T3 Code",
                location: { directory: cwd },
                model,
                permissions: openCode2Rules(input.runtimeMode, input.threadId, false),
              },
              { signal },
            ),
          );
      if (native.location.directory !== cwd)
        return yield* nativeError(
          "session.get",
          new Error("The OpenCode session belongs to a different workspace."),
        );
      const now = DateTime.formatIso(yield* DateTime.now);
      const context: Context = {
        native,
        client: connection.client,
        plan: false,
        stopped: false,
        grants: [],
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        permissions: new Map(),
        forms: new Map(),
        items: new Map(),
        turns: [],
        lock: yield* Semaphore.make(1),
        session: {
          provider: PROVIDER,
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          cwd,
          model: input.modelSelection?.model,
          status: "ready",
          createdAt: now,
          updatedAt: now,
          resumeCursor: { openCode2SessionId: native.id },
        },
      };
      sessions.set(input.threadId, context);
      nativeSessions.set(native.id, context);
      yield* request("session.update", (signal) =>
        context.client.session.update(
          {
            sessionID: native.id,
            permissions: openCode2Rules(input.runtimeMode, input.threadId, false),
          },
          { signal },
        ),
      );
      yield* emit(context, "session.started", { resume: context.session.resumeCursor });
      yield* emit(context, "thread.started", { providerThreadId: native.id });
      return context.session;
    });

  const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* get(input.threadId);
      return yield* Effect.gen(function* () {
        if (context.active)
          return yield* nativeError(
            "session.prompt",
            new Error("A turn is already running. Stop it before sending a new turn."),
          );
        if (pumpFailure) return yield* nativeError("session.prompt", pumpFailure);
        const modelSelection = input.modelSelection ?? context.modelSelection;
        const model = yield* Effect.try({
          try: () => openCode2Model(modelSelection),
          catch: (cause) => nativeError("model", cause),
        });
        context.plan = input.interactionMode === "plan";
        yield* request("session.model", (signal) =>
          context.client.session.switchModel({ sessionID: context.native.id, model }, { signal }),
        );
        yield* request("session.agent", (signal) =>
          context.client.session.switchAgent(
            { sessionID: context.native.id, agent: context.plan ? "plan" : "build" },
            { signal },
          ),
        );
        yield* request("session.permissions", (signal) =>
          context.client.session.update(
            {
              sessionID: context.native.id,
              permissions: openCode2Rules(
                context.session.runtimeMode,
                input.threadId,
                context.plan,
                context.grants,
              ),
            },
            { signal },
          ),
        );
        if (modelSelection) context.modelSelection = modelSelection;
        context.session = { ...context.session, model: `${model.providerID}/${model.id}` };
        yield* setup(context);
        const id = TurnId.make(`msg_${NodeCrypto.randomUUID().replaceAll("-", "")}`);
        const attachments = input.attachments ?? [];
        const text = [
          input.input ?? "",
          ...(input.referenceMaterials ?? []).map((material) => JSON.stringify(material)),
        ]
          .filter(Boolean)
          .join("\n\n");
        const files = yield* Effect.try({
          try: () =>
            attachments.map((attachment) => {
              const path = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!path) throw new Error("An attachment has no environment-local file path.");
              return { uri: NodeURL.pathToFileURL(path).href, name: attachment.name };
            }),
          catch: (cause) => nativeError("attachment", cause),
        });
        context.active = id;
        context.turns.push({ id, items: [] });
        context.session = { ...context.session, status: "running", activeTurnId: id };
        yield* emit(context, "turn.started", { model: context.session.model });
        const submitted = yield* request("session.prompt", (signal) =>
          context.client.session.prompt(
            { sessionID: context.native.id, id, text, ...(files.length ? { files } : {}) },
            { signal },
          ),
        ).pipe(Effect.exit);
        if (submitted._tag === "Failure") {
          yield* finish(
            context,
            "failed",
            "OpenCode did not acknowledge the prompt. Check its session before retrying.",
          );
          return yield* Effect.failCause(submitted.cause);
        }
        return { threadId: input.threadId, turnId: id, resumeCursor: context.session.resumeCursor };
      }).pipe(context.lock.withPermits(1));
    });

  const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* get(threadId);
      yield* request("session.interrupt", (signal) =>
        context.client.session.interrupt({ sessionID: context.native.id }, { signal }),
      );
      yield* finish(context, "interrupted");
    });
  const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (threadId, id, decision) =>
    Effect.gen(function* () {
      const context = yield* get(threadId);
      const native = context.permissions.get(id);
      if (!native)
        return yield* nativeError(
          "permission.reply",
          new Error("This approval is no longer pending."),
        );
      const allow =
        decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";
      // Keep every native reply local to this request, including session grants.
      if (allow && decision !== "accept") {
        context.grants = [
          ...context.grants,
          ...native.resources.map((resource) => ({
            action: native.action,
            resource,
            effect: "allow" as const,
          })),
        ];
        yield* request("session.permissions", (signal) =>
          context.client.session.update(
            {
              sessionID: native.sessionID,
              permissions: openCode2Rules(
                context.session.runtimeMode,
                threadId,
                context.plan,
                context.grants,
              ),
            },
            { signal },
          ),
        );
      }
      yield* request("permission.reply", (signal) =>
        context.client.permission.reply(
          {
            sessionID: native.sessionID,
            requestID: native.id,
            decision: allow ? "once" : "reject",
            ...(!allow
              ? { message: "The user denied this action. Continue without performing it." }
              : {}),
          },
          { signal },
        ),
      );
    });
  const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
    threadId,
    id,
    answers: ProviderUserInputAnswers,
  ) =>
    Effect.gen(function* () {
      const context = yield* get(threadId);
      const native = context.forms.get(id);
      if (!native)
        return yield* nativeError("form.reply", new Error("This question is no longer pending."));
      const answer: Record<string, string | string[]> = {};
      for (const field of native.fields) {
        const raw = answers[field.key];
        const values = (Array.isArray(raw) ? raw : [raw]).filter(
          (value): value is string => typeof value === "string",
        );
        const mapped = values.map(
          (value) =>
            (field.type === "string" || field.type === "multiselect"
              ? field.options
              : undefined
            )?.find((option) => option.label === value)?.value ?? value,
        );
        answer[field.key] = field.type === "multiselect" ? mapped : mapped.join(", ");
      }
      yield* request("form.reply", (signal) =>
        context.client.session.form.reply(
          { sessionID: native.sessionID, formID: native.id, answer },
          { signal },
        ),
      );
    });
  const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) return;
      if (context.active) yield* interruptTurn(threadId).pipe(Effect.ignore);
      if (context.mcp) {
        const mcp = context.mcp;
        yield* request("mcp.remove", (signal) =>
          context.client.mcp.remove(
            { server: mcp.name, location: { directory: mcp.directory } },
            { signal },
          ),
        ).pipe(Effect.ignore);
      }
      context.stopped = true;
      for (const [nativeId, owner] of nativeSessions)
        if (owner === context) nativeSessions.delete(nativeId);
      sessions.delete(threadId);
      yield* emit(context, "session.exited", {
        reason: "Stopped by T3 Code",
        exitKind: "graceful",
      });
    });
  const stopAll = () =>
    Effect.forEach([...sessions.keys()], stopSession, { discard: true }).pipe(Effect.ignore);
  const readThread: OpenCodeAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* get(threadId);
      const turns: Context["turns"] = [];
      let cursor: string | undefined;
      do {
        const page = yield* request("message.list", (signal) =>
          context.client.message.list(
            {
              sessionID: context.native.id,
              ...(cursor ? { cursor } : { limit: 100, order: "asc", type: "user" }),
            },
            { signal },
          ),
        );
        for (const message of page.data)
          if (message.type === "user")
            turns.push({ id: TurnId.make(message.id), items: [message] });
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
      context.turns = turns;
      return { threadId, turns };
    });
  const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const context = yield* get(threadId);
      if (context.active)
        return yield* nativeError(
          "session.revert",
          new Error("Stop the current turn before reverting."),
        );
      const before = yield* readThread(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1 || numTurns > before.turns.length)
        return yield* nativeError(
          "session.revert",
          new Error("Invalid number of turns to revert."),
        );
      const boundary = before.turns[before.turns.length - numTurns]!.id;
      yield* request("session.revert.stage", (signal) =>
        context.client.session.revert.stage(
          { sessionID: context.native.id, messageID: boundary, files: false },
          { signal },
        ),
      );
      yield* request("session.revert.commit", (signal) =>
        context.client.session.revert.commit({ sessionID: context.native.id }, { signal }),
      );
      return yield* readThread(threadId);
    });
  const compact = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = yield* get(threadId);
      if (context.active)
        return yield* nativeError(
          "session.compact",
          new Error("Stop the current turn before compacting."),
        );
      const id = TurnId.make(`msg_${NodeCrypto.randomUUID().replaceAll("-", "")}`);
      context.active = id;
      context.session = { ...context.session, activeTurnId: id, status: "running" };
      yield* emit(context, "turn.started", { model: context.session.model });
      const result = yield* request("session.compact", (signal) =>
        context.client.session.compact({ sessionID: context.native.id, id }, { signal }),
      ).pipe(Effect.exit);
      if (result._tag === "Failure") {
        yield* finish(context, "failed", "OpenCode could not start compaction.");
        return yield* Effect.failCause(result.cause);
      }
    });
  yield* Effect.addFinalizer(stopAll);
  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (id) => Effect.sync(() => sessions.has(id)),
    readThread,
    rollbackThread,
    compaction: { type: "native", start: compact },
    streamEvents: Stream.fromQueue(events),
  } satisfies OpenCodeAdapterShape;
});
