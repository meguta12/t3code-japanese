import {
  deriveDelegationStatus,
  DELEGATION_ORIGIN_ACTIVITY_KIND,
  DELEGATION_STARTED_ACTIVITY_KIND,
  DelegationOriginPayload,
  DelegationStartedPayload,
  type DelegationPreset,
  type OrchestrationLatestTurn,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  RuntimeSubagent,
  RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  DelegatedChildRun,
  DelegatedRunStatus,
} from "../components/chat/composerRunningModel";

/**
 * Pure helpers for agent delegation. The parent/child link lives in two thread
 * activities and a child's progress is read from the child's own thread shell,
 * so everything here is a function of those two inputs.
 */

const decodeStarted = Schema.decodeUnknownOption(DelegationStartedPayload);
const decodeOrigin = Schema.decodeUnknownOption(DelegationOriginPayload);

interface ActivityLike {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

/**
 * The delegations a parent thread started, oldest first, one per child. The
 * client only holds the newest activities of a long thread, so a very old
 * delegation can be missing here.
 */
export function deriveDelegationStarts(
  activities: ReadonlyArray<ActivityLike>,
): ReadonlyArray<DelegationStartedPayload> {
  const starts: DelegationStartedPayload[] = [];
  const seen = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== DELEGATION_STARTED_ACTIVITY_KIND) continue;
    const payload = decodeStarted(activity.payload);
    if (Option.isNone(payload) || seen.has(payload.value.childThreadId)) continue;
    seen.add(payload.value.childThreadId);
    starts.push(payload.value);
  }
  return starts.toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

/** The parent a delegated child thread was started from, or null for an ordinary thread. */
export function deriveDelegationOrigin(activities: ReadonlyArray<ActivityLike>): ThreadId | null {
  for (const activity of activities) {
    if (activity.kind !== DELEGATION_ORIGIN_ACTIVITY_KIND) continue;
    const payload = decodeOrigin(activity.payload);
    if (Option.isSome(payload)) return payload.value.parentThreadId;
  }
  return null;
}

/** The parts of a thread shell that say how a delegated child is doing. */
export interface DelegatedChildShell {
  readonly hasPendingTurnStart?: boolean | undefined;
  readonly session?: { readonly status: string; readonly updatedAt: string } | null | undefined;
  readonly modelSelection?: ModelSelection;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state" | "requestedAt"> | null;
  readonly latestUserMessageAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

/**
 * Child status from its shell alone. Anything waiting on the user wins; a
 * follow-up sent after the last turn was requested means a new turn is queued,
 * so the old turn's outcome no longer describes the child; a child with no turn
 * yet is still starting.
 */
export function deriveDelegatedRunStatus(shell: DelegatedChildShell): DelegatedRunStatus {
  const status = deriveDelegationStatus(shell);
  return status === "needs_user_action" ? "awaiting" : status;
}

/** null means removed; undefined means its shell has not loaded yet. */
export function deriveDelegatedRuns(
  starts: ReadonlyArray<DelegationStartedPayload>,
  shellFor: (childThreadId: ThreadId) => DelegatedChildShell | null | undefined,
  previous: ReadonlyArray<DelegatedChildRun> = [],
): ReadonlyArray<DelegatedChildRun> {
  return starts.flatMap((start) => {
    const shell = shellFor(start.childThreadId);
    if (shell === null) return [];
    if (shell === undefined) {
      const known = previous.find((run) => run.threadId === start.childThreadId);
      if (known) return [known];
    }
    const selection = shell?.modelSelection;
    const currentEffort = selection?.options?.find(
      (option) => option.id === "effort" || option.id === "reasoningEffort",
    )?.value;
    return [
      {
        threadId: start.childThreadId,
        title: start.title,
        instanceId: selection?.instanceId ?? start.provider,
        model: selection?.model ?? start.model,
        effort: selection
          ? typeof currentEffort === "string"
            ? currentEffort
            : null
          : start.effort,
        status: shell === undefined ? "queued" : deriveDelegatedRunStatus(shell),
      },
    ];
  });
}

export function delegatedRunsEqual(
  left: ReadonlyArray<DelegatedChildRun>,
  right: ReadonlyArray<DelegatedChildRun>,
): boolean {
  return (
    left.length === right.length &&
    left.every((run, index) => {
      const other = right[index]!;
      return (
        run.threadId === other.threadId &&
        run.title === other.title &&
        run.instanceId === other.instanceId &&
        run.model === other.model &&
        (run.effort ?? null) === (other.effort ?? null) &&
        run.status === other.status
      );
    })
  );
}

const DELEGATED_AGENT_STATUS: Record<DelegatedRunStatus, RuntimeSubagentStatus> = {
  queued: "pending",
  running: "running",
  awaiting: "waiting",
  completed: "completed",
  error: "failed",
  interrupted: "interrupted",
};

/**
 * Delegated child threads as rows for the Agents panel. Only the child's
 * status is known, not when it settled, so settled rows carry no start time
 * and show no elapsed clock.
 */
export function deriveDelegatedAgents(
  starts: ReadonlyArray<DelegationStartedPayload>,
  runs: ReadonlyArray<DelegatedChildRun>,
): ReadonlyArray<RuntimeSubagent> {
  const startByChild = new Map(starts.map((start) => [start.childThreadId, start] as const));
  return runs.flatMap((run) => {
    const start = startByChild.get(run.threadId);
    if (!start) return [];
    const status = DELEGATED_AGENT_STATUS[run.status];
    const live = status === "pending" || status === "running" || status === "waiting";
    return [
      {
        id: `delegated:${run.threadId}`,
        kind: "subagent",
        title: start.title,
        role: start.presetName ?? run.instanceId,
        model: run.model,
        effort: run.effort ?? null,
        status,
        activationCount: 1,
        usage: null,
        progress: run.status === "awaiting" ? "ユーザーの対応待ち（開いて確認）" : null,
        lastToolName: null,
        result: null,
        error: null,
        outputFile: null,
        parentAgentId: null,
        agentIndex: null,
        phaseIndex: null,
        phaseTitle: null,
        attempt: null,
        workflowName: null,
        phases: [],
        runHandles: null,
        recentActivity: [],
        firstSeenAt: start.createdAt,
        startedAt: live ? start.createdAt : null,
        completedAt: null,
        updatedAt: start.createdAt,
        delegatedThreadId: run.threadId,
      } satisfies RuntimeSubagent,
    ];
  });
}

/** Trim and collapse inner whitespace, so "実装役 " and "実装役" are one name. */
export function normalizePresetName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ");
}

/** Names compare equal across width and case: "Review" = "review" = "ＲＥＶＩＥＷ". */
export function presetNameKey(name: string): string {
  return normalizePresetName(name).toLowerCase();
}

export type PresetNameProblem = "empty" | "duplicate";

/** Whether `name` can be saved for the preset `presetId` among `presets`. */
export function validatePresetName(
  name: string,
  presetId: string,
  presets: ReadonlyArray<Pick<DelegationPreset, "id" | "name">>,
): PresetNameProblem | null {
  const key = presetNameKey(name);
  if (key === "") return "empty";
  return presets.some((preset) => preset.id !== presetId && presetNameKey(preset.name) === key)
    ? "duplicate"
    : null;
}

/** The first unused "役割N", for a preset added without a name. */
export function nextPresetName(presets: ReadonlyArray<Pick<DelegationPreset, "name">>): string {
  const taken = new Set(presets.map((preset) => presetNameKey(preset.name)));
  for (let index = 1; ; index += 1) {
    const candidate = `役割${index}`;
    if (!taken.has(presetNameKey(candidate))) return candidate;
  }
}

/**
 * Whether a saved preset's model is still offered: its provider instance is
 * enabled and available and the model is in that instance's list.
 */
export function isPresetModelOffered(input: {
  readonly entry: { readonly enabled: boolean; readonly isAvailable: boolean } | undefined;
  readonly options:
    | ReadonlyArray<{ readonly slug: string; readonly isUnavailable?: boolean | undefined }>
    | undefined;
  readonly model: string;
}): boolean {
  return (
    input.entry !== undefined &&
    input.entry.enabled &&
    input.entry.isAvailable &&
    (input.options?.some((option) => option.slug === input.model && !option.isUnavailable) ?? false)
  );
}
