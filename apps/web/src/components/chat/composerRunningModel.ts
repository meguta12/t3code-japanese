import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  resolveSelectableModel,
} from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  isActiveSubagentStatus,
  type AgentPanelModel,
  type RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { SessionPhase } from "../../types";
import { getTriggerDisplayModelName } from "./providerIconUtils";

/**
 * Pure view-model for the strip above the composer input that says which model
 * is running (or will run next). The client only knows the selection a turn was
 * STARTED with (the thread's persisted selection, written before each send), so
 * that is what "指定" means. "実際" is reserved for a model the server reports
 * as having served the turn (`servedModel`, from `turn.model-reported` activities;
 * see lib/servedModel.ts). Providers that report no model leave it empty.
 */

export type RunningModelState =
  | "idle"
  | "connecting"
  | "running"
  | "awaiting-approval"
  | "awaiting-input"
  | "error";

export type RunningModelTone = "neutral" | "info" | "warning" | "error";

/** 指定: what the in-flight (or last) turn was started with. 次に使う: the composer's selection. */
export type RunningModelBasis = "requested" | "next";

export interface RunningModelTarget {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind | null;
  readonly providerName: string;
  readonly modelSlug: string;
  readonly modelName: string;
  readonly effortId: string | null;
  readonly effortLabel: string | null;
  readonly fastMode: boolean;
}

/** What the server later reports as having actually served a turn (stage B). */
export interface ServedModelReport {
  readonly model: string;
  readonly effort?: string | null | undefined;
}

export type DelegatedRunStatus =
  | "queued"
  | "running"
  | "awaiting"
  | "completed"
  | "error"
  | "interrupted";

/** A child thread running on another provider/model; see lib/delegation.ts for how it is derived. */
export interface DelegatedChildRun {
  readonly title?: string;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly effort?: string | null | undefined;
  readonly status: DelegatedRunStatus;
}

export interface DelegatedRunChip {
  readonly title?: string;
  readonly threadId: ThreadId;
  readonly driverKind: ProviderDriverKind | null;
  readonly providerName: string;
  readonly modelName: string;
  readonly effortLabel: string | null;
  readonly statusLabel: string;
  readonly tone: RunningModelTone;
}

export interface RunningSubagent {
  readonly id: string;
  readonly title: string;
  readonly model: string | null;
  readonly status: RuntimeSubagentStatus;
}

const EMPTY_SUBAGENTS: ReadonlyArray<RunningSubagent> = Object.freeze([]);

/** Keep the chip stable when the shared Agents fold only changes activity or usage. */
export function deriveRunningSubagents(
  model: AgentPanelModel | undefined,
  previous: ReadonlyArray<RunningSubagent> = EMPTY_SUBAGENTS,
): ReadonlyArray<RunningSubagent> {
  if (!model) return previous.length === 0 ? previous : EMPTY_SUBAGENTS;
  const next = [
    ...model.directAgents,
    ...model.workflows.flatMap((group) => {
      const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
      return members.length === 0 ? [group.workflow] : members;
    }),
  ]
    .filter((agent) => isActiveSubagentStatus(agent.status))
    .map(({ id, title, model: agentModel, status }) => ({ id, title, model: agentModel, status }));
  return previous.length === next.length &&
    previous.every((agent, index) => {
      const other = next[index]!;
      return (
        agent.id === other.id &&
        agent.title === other.title &&
        agent.model === other.model &&
        agent.status === other.status
      );
    })
    ? previous
    : next;
}

export function isActiveDelegatedRun(status: DelegatedRunStatus): boolean {
  return status === "queued" || status === "running" || status === "awaiting";
}

export interface RunningModelStripInput {
  readonly phase: SessionPhase;
  readonly sessionStatus?: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  /** The thread's persisted selection: what the in-flight or last turn was started with. */
  readonly requestedSelection?: ModelSelection | null | undefined;
  /** The composer's current selection: what the next send will use. */
  readonly nextSelection?: ModelSelection | null | undefined;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly servedModel?: ServedModelReport | null | undefined;
  readonly delegatedRuns?: ReadonlyArray<DelegatedChildRun> | undefined;
  readonly subagents?: ReadonlyArray<RunningSubagent> | undefined;
}

export interface RunningModelStripView {
  readonly state: RunningModelState;
  readonly stateLabel: string;
  readonly tone: RunningModelTone;
  readonly basis: RunningModelBasis;
  readonly basisLabel: string;
  readonly target: RunningModelTarget | null;
  readonly served: { readonly modelName: string; readonly effortLabel: string | null } | null;
  /** True only when a servedModel was reported and it differs from the requested model/effort. */
  readonly mismatch: boolean;
  readonly delegated: ReadonlyArray<DelegatedRunChip>;
  readonly subagents: ReadonlyArray<RunningSubagent>;
}

const STATE_LABELS: Record<RunningModelState, string> = {
  idle: "待機中",
  connecting: "接続中",
  running: "実行中",
  "awaiting-approval": "承認待ち",
  "awaiting-input": "入力待ち",
  error: "エラー",
};

const STATE_TONES: Record<RunningModelState, RunningModelTone> = {
  idle: "neutral",
  connecting: "neutral",
  running: "info",
  "awaiting-approval": "warning",
  "awaiting-input": "warning",
  error: "error",
};

const BASIS_LABELS: Record<RunningModelBasis, string> = {
  requested: "指定",
  next: "次に使う",
};

export const SERVED_BASIS_LABEL = "実際";

const DELEGATED_STATUS: Record<DelegatedRunStatus, { label: string; tone: RunningModelTone }> = {
  queued: { label: "待機中", tone: "neutral" },
  running: { label: "実行中", tone: "info" },
  awaiting: { label: "要対応", tone: "warning" },
  completed: { label: "完了", tone: "neutral" },
  error: { label: "エラー", tone: "error" },
  interrupted: { label: "中断", tone: "neutral" },
};

export function deriveRunningModelState(input: {
  readonly phase: SessionPhase;
  readonly sessionStatus?: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
}): RunningModelState {
  if (input.hasPendingApproval) return "awaiting-approval";
  if (input.hasPendingUserInput) return "awaiting-input";
  if (input.phase === "running") return "running";
  if (input.phase === "connecting") return "connecting";
  if (input.sessionStatus === "error" || input.latestTurnState === "error") return "error";
  return "idle";
}

// Option ids that are not the reasoning effort even though they are `select`s.
const NON_EFFORT_SELECT_IDS = new Set(["contextWindow", "agent", "serviceTier"]);
const EFFORT_IDS = ["effort", "reasoningEffort"] as const;

function pickEffortDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  const selects = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  return (
    selects.find((descriptor) => EFFORT_IDS.some((id) => id === descriptor.id)) ??
    selects.find((descriptor) => !NON_EFFORT_SELECT_IDS.has(descriptor.id)) ??
    null
  );
}

function rawOption(selection: ModelSelection, id: string): string | boolean | null {
  return selection.options?.find((option) => option.id === id)?.value ?? null;
}

function deriveTraits(
  selection: ModelSelection,
  model: ServerProviderModel | undefined,
): { effortId: string | null; effortLabel: string | null; fastMode: boolean } {
  const descriptors = getProviderOptionDescriptors({
    caps: model?.capabilities ?? {},
    selections: selection.options,
  });
  const effort = pickEffortDescriptor(descriptors);
  let effortId: string | null = null;
  let effortLabel: string | null = null;
  if (effort) {
    const current = getProviderOptionCurrentValue(effort);
    effortId = typeof current === "string" ? current : null;
    effortLabel = getProviderOptionCurrentLabel(effort) ?? effortId;
  } else {
    // Unknown or custom model without descriptors: show what was actually requested.
    for (const id of EFFORT_IDS) {
      const raw = rawOption(selection, id);
      if (typeof raw === "string") {
        effortId = raw;
        effortLabel = raw;
        break;
      }
    }
  }

  let fastMode = false;
  const fastDescriptor = descriptors.find(
    (descriptor) => descriptor.id === "fastMode" && descriptor.type === "boolean",
  );
  if (fastDescriptor?.type === "boolean") {
    fastMode = fastDescriptor.currentValue === true;
  } else {
    const tier = descriptors.find(
      (descriptor) => descriptor.id === "serviceTier" && descriptor.type === "select",
    );
    if (tier?.type === "select") {
      const fastTier = tier.options.find(({ label }) => label === "Fast");
      fastMode = fastTier !== undefined && getProviderOptionCurrentValue(tier) === fastTier.id;
    } else {
      fastMode = rawOption(selection, "fastMode") === true;
    }
  }
  return { effortId, effortLabel, fastMode };
}

function findModel(
  entry: ProviderInstanceEntry | undefined,
  model: string,
): ServerProviderModel | undefined {
  if (!entry) return undefined;
  const slug = resolveSelectableModel(entry.driverKind, model, entry.models);
  return entry.models.find((candidate) => candidate.slug === slug);
}

export function resolveRunningModelTarget(
  selection: ModelSelection | null | undefined,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): RunningModelTarget | null {
  // An empty model is the "no provider" placeholder; there is nothing to show.
  if (!selection || selection.model.trim() === "") return null;
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = findModel(entry, selection.model);
  return {
    instanceId: selection.instanceId,
    driverKind: entry?.driverKind ?? null,
    providerName: entry?.displayName ?? selection.instanceId,
    modelSlug: model?.slug ?? selection.model,
    modelName: model ? getTriggerDisplayModelName(model) : selection.model,
    ...deriveTraits(selection, model),
  };
}

function normalizedEffort(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Whether the model that served a turn differs from the one requested. Both sides
 * are canonicalized through the provider's catalog (slug, name, alias) so an alias
 * does not read as a mismatch. Effort only counts when the server reported one.
 */
export function servedModelMismatch(input: {
  readonly requested: Pick<RunningModelTarget, "driverKind" | "modelSlug" | "effortId">;
  readonly served: ServedModelReport;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): boolean {
  const { requested, served, models } = input;
  const canonical = (value: string): string => {
    const resolved = requested.driverKind
      ? resolveSelectableModel(requested.driverKind, value, models)
      : null;
    return (resolved ?? value).trim().toLowerCase();
  };
  if (canonical(requested.modelSlug) !== canonical(served.model)) return true;
  const servedEffort = normalizedEffort(served.effort);
  const requestedEffort = normalizedEffort(requested.effortId);
  return servedEffort !== null && requestedEffort !== null && servedEffort !== requestedEffort;
}

function deriveDelegatedChips(
  runs: ReadonlyArray<DelegatedChildRun>,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<DelegatedRunChip> {
  return runs.map((run) => {
    const entry = entries.find((candidate) => candidate.instanceId === run.instanceId);
    const model = findModel(entry, run.model);
    const status = DELEGATED_STATUS[run.status];
    return {
      threadId: run.threadId,
      ...(run.title ? { title: run.title } : {}),
      driverKind: entry?.driverKind ?? null,
      providerName: entry?.displayName ?? run.instanceId,
      modelName: model ? getTriggerDisplayModelName(model) : run.model,
      effortLabel: run.effort ?? null,
      statusLabel: status.label,
      tone: status.tone,
    };
  });
}

export function deriveRunningModelStrip(input: RunningModelStripInput): RunningModelStripView {
  const state = deriveRunningModelState(input);
  const turnInFlightOrFailed = state !== "idle";
  const requested = turnInFlightOrFailed
    ? resolveRunningModelTarget(input.requestedSelection, input.entries)
    : null;
  const target = requested ?? resolveRunningModelTarget(input.nextSelection, input.entries);
  const basis: RunningModelBasis = requested ? "requested" : "next";

  // A served model only describes a turn that has started; never pair it with "next".
  const entry = target
    ? input.entries.find((candidate) => candidate.instanceId === target.instanceId)
    : undefined;
  const served = basis === "requested" && target && input.servedModel ? input.servedModel : null;
  const servedTarget = served
    ? {
        modelName: (() => {
          const model = findModel(entry, served.model);
          return model ? getTriggerDisplayModelName(model) : served.model;
        })(),
        effortLabel: served.effort ?? null,
      }
    : null;

  return {
    state,
    stateLabel: STATE_LABELS[state],
    tone: STATE_TONES[state],
    basis,
    basisLabel: BASIS_LABELS[basis],
    target,
    served: servedTarget,
    mismatch:
      served !== null && target !== null
        ? servedModelMismatch({ requested: target, served, models: entry?.models ?? [] })
        : false,
    delegated: deriveDelegatedChips(input.delegatedRuns ?? [], input.entries),
    subagents: input.subagents ?? EMPTY_SUBAGENTS,
  };
}

/** The footer only receives a new view when one of its displayed scalar values changes. */
export function createRunningModelStripSelector() {
  let previous: RunningModelStripView | null = null;
  let previousKey = "";
  return (input: RunningModelStripInput): RunningModelStripView => {
    const next = deriveRunningModelStrip(input);
    // This is the small, bounded display model, never thread messages or activities.
    const key = JSON.stringify(next);
    if (previous !== null && key === previousKey) return previous;
    previous = next;
    previousKey = key;
    return next;
  };
}
