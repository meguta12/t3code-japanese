import {
  MAX_CONCURRENT_DELEGATED_TASKS,
  McpCapabilityUnavailableError,
  PositiveInt,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderRegistry.ProviderRegistry,
  ServerSettings.ServerSettingsService,
];

/** Longest a single wait blocks; MCP clients commonly give up on a call after about a minute. */
export const MAX_WAIT_SECONDS = 50;
export const DEFAULT_WAIT_SECONDS = 30;

export const DelegationRejectionCode = Schema.Literals([
  "missing_target",
  "unknown_preset",
  "preset_unavailable",
  "unknown_provider",
  "ambiguous_provider",
  "unknown_model",
  "ambiguous_model",
  "unsupported_effort",
  "provider_not_ready",
  "nested_delegation",
  "too_many_running",
  "task_running",
  "unknown_task",
  "thread_not_found",
]);
export type DelegationRejectionCode = typeof DelegationRejectionCode.Type;

/** The request was understood and refused; `detail` says what to change, `candidates` lists valid values. */
export class DelegationRejectedError extends Schema.TaggedError<DelegationRejectedError>()(
  "DelegationRejectedError",
  {
    code: DelegationRejectionCode,
    detail: Schema.String,
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class DelegationFailedError extends Schema.TaggedError<DelegationFailedError>()(
  "DelegationFailedError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Delegation ${this.operation} failed.`;
  }
}

export const DelegationToolError = Schema.Union([
  McpCapabilityUnavailableError,
  DelegationRejectedError,
  DelegationFailedError,
]);
export type DelegationToolError = typeof DelegationToolError.Type;

export const DelegatedTaskStatus = Schema.Literals([
  "running",
  "completed",
  "error",
  "interrupted",
  "needs_user_action",
]);
export type DelegatedTaskStatus = typeof DelegatedTaskStatus.Type;

const OptionValue = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  isDefault: Schema.Boolean,
});

export const ListModelsResult = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId.annotate({
        description: "Instance id. Pass it as `provider` to delegate_task.",
      }),
      name: Schema.String,
      ready: Schema.Boolean,
      notReadyReason: Schema.optional(Schema.String),
      models: Schema.Array(
        Schema.Struct({
          model: Schema.String.annotate({ description: "Slug. Pass it as `model`." }),
          name: Schema.String,
          aliases: Schema.Array(Schema.String),
          isDefault: Schema.Boolean,
          options: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              label: Schema.String,
              kind: Schema.Literals(["select", "boolean"]),
              values: Schema.Array(OptionValue).annotate({
                description:
                  "Accepted values. The reasoning or effort option is what `effort` selects.",
              }),
            }),
          ),
        }),
      ),
    }),
  ),
  presets: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "Pass it as `preset`." }),
      available: Schema.Boolean,
      provider: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      effort: Schema.NullOr(Schema.String),
      problem: Schema.optional(Schema.String),
    }),
  ),
  maxConcurrentTasks: Schema.Int,
});
export type ListModelsResult = typeof ListModelsResult.Type;

const ResolvedTarget = Schema.Struct({
  provider: Schema.String,
  providerName: Schema.String,
  model: Schema.String,
  modelName: Schema.String,
  effort: Schema.NullOr(Schema.String).annotate({
    description: "Effort the task runs with; null means the provider's default.",
  }),
  preset: Schema.optional(Schema.String),
});

export const DelegateTaskInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "The complete instruction for the delegated agent. It starts with no memory of this conversation, so include the goal, file paths, constraints and what to report back.",
  }),
  preset: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        'Name of a saved delegation preset, for example "実装役". Wins over provider, model and effort.',
    }),
  ),
  provider: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Provider instance id or name from list_models, for example codex or claude.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Model slug, name or alias from list_models, for example gpt-6.1-sol. Matching is exact apart from case and separators.",
    }),
  ),
  effort: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Effort the model offers, for example low, medium, high, xhigh, max, ultra. Japanese words such as ウルトラ are accepted.",
    }),
  ),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Short title for the child thread; shown to the user as 「[委譲] <title>」.",
    }),
  ),
});
export type DelegateTaskInput = typeof DelegateTaskInput.Type;

export const DelegateTaskResult = Schema.Struct({
  taskId: ThreadId.annotate({
    description: "Id of the child thread. Pass it to the other delegation tools.",
  }),
  threadTitle: Schema.String,
  resolved: ResolvedTarget,
  status: Schema.Literal("running"),
  notes: Schema.Array(Schema.String),
});
export type DelegateTaskResult = typeof DelegateTaskResult.Type;

const TaskIdInput = {
  taskId: ThreadId.annotate({ description: "taskId returned by delegate_task." }),
};

export const WaitDelegatedTaskInput = Schema.Struct({
  ...TaskIdInput,
  timeoutSeconds: Schema.optional(
    PositiveInt.annotate({
      description: `Longest to wait, capped at ${MAX_WAIT_SECONDS}. Defaults to ${DEFAULT_WAIT_SECONDS}. On running, call again.`,
    }),
  ),
});
export type WaitDelegatedTaskInput = typeof WaitDelegatedTaskInput.Type;

export const DelegatedTaskStateResult = Schema.Struct({
  taskId: ThreadId,
  childThreadId: ThreadId,
  title: Schema.String,
  status: DelegatedTaskStatus,
  finalMessage: Schema.optional(
    Schema.String.annotate({
      description: "The child's last assistant message of its latest turn, when it has one.",
    }),
  ),
  hint: Schema.optional(Schema.String),
});
export type DelegatedTaskStateResult = typeof DelegatedTaskStateResult.Type;

export const SendToDelegatedTaskInput = Schema.Struct({
  ...TaskIdInput,
  message: TrimmedNonEmptyString.annotate({
    description:
      "Follow-up instruction for a finished delegated agent, sent as a new turn. Running tasks reject follow-ups.",
  }),
});
export type SendToDelegatedTaskInput = typeof SendToDelegatedTaskInput.Type;

export const StopDelegatedTaskInput = Schema.Struct(TaskIdInput);
export type StopDelegatedTaskInput = typeof StopDelegatedTaskInput.Type;

export const StopDelegatedTaskResult = Schema.Struct({
  taskId: ThreadId,
  interrupted: Schema.Boolean.annotate({
    description: "False when the task had no running turn to stop.",
  }),
  status: DelegatedTaskStatus,
});
export type StopDelegatedTaskResult = typeof StopDelegatedTaskResult.Type;

const ListModelsTool = Tool.make("list_models", {
  description:
    "List the providers, models, effort options and saved delegation presets this server can delegate work to. Call it before delegate_task whenever the user names a model, provider, effort or preset, so you pass names that exist.",
  success: ListModelsResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "List delegation targets")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DelegateTaskTool = Tool.make("delegate_task", {
  description: `Start a task on a different provider, model or effort in a new thread of this project, sharing this thread's working directory, and return immediately with a taskId. Use it when the user asks for work to be done by another model, provider, effort or preset; do not do that work yourself. Tell the user the child thread title and the resolved model. At most ${MAX_CONCURRENT_DELEGATED_TASKS} tasks run at once. Collect the result with wait_delegated_task. Not available inside a delegated thread.`,
  parameters: DelegateTaskInput,
  success: DelegateTaskResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const WaitDelegatedTaskTool = Tool.make("wait_delegated_task", {
  description: `Wait up to ${MAX_WAIT_SECONDS} seconds for a delegated task and report its status: running, completed (with the child's final message), error, interrupted, or needs_user_action when the child waits on an approval or question that only the user can answer; then ask the user to open that thread. On running, call again.`,
  parameters: WaitDelegatedTaskInput,
  success: DelegatedTaskStateResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for delegated task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SendToDelegatedTaskTool = Tool.make("send_to_delegated_task", {
  description:
    "Send a follow-up instruction to a finished task you delegated, as a new turn on the same child thread and model. Returns immediately; collect the answer with wait_delegated_task.",
  parameters: SendToDelegatedTaskInput,
  success: DelegatedTaskStateResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message delegated task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const StopDelegatedTaskTool = Tool.make("stop_delegated_task", {
  description: "Interrupt the running turn of a task you delegated. The child thread stays open.",
  parameters: StopDelegatedTaskInput,
  success: StopDelegatedTaskResult,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop delegated task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DelegationToolkit = Toolkit.make(
  ListModelsTool,
  DelegateTaskTool,
  WaitDelegatedTaskTool,
  SendToDelegatedTaskTool,
  StopDelegatedTaskTool,
);
