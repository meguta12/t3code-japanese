import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Agent delegation links a parent thread to the child threads it started on
 * another provider, model or effort. The link is two thread activities, so it
 * needs no migration and survives restarts with the rest of the thread:
 * `delegation.started` on the parent, `delegation.origin` on the child. A
 * child's progress is read from the child thread itself.
 *
 * Both activities are internal: clients hide them from the work log.
 */
export const DELEGATION_STARTED_ACTIVITY_KIND = "delegation.started";
export const DELEGATION_ORIGIN_ACTIVITY_KIND = "delegation.origin";

/** One parent may have this many children running at once. */
export const MAX_CONCURRENT_DELEGATED_TASKS = 3;

/** Activity ids are fixed per child, so replaying the append is idempotent. */
export const delegationStartedActivityId = (childThreadId: ThreadId) =>
  `delegation:started:${childThreadId}`;
export const delegationOriginActivityId = (childThreadId: ThreadId) =>
  `delegation:origin:${childThreadId}`;

/** Payload of `delegation.started`, appended to the parent thread. */
export const DelegationStartedPayload = Schema.Struct({
  childThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  /** Provider instance id the child runs on. */
  provider: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  /** Effort option id the child was started with; null when the provider default applies. */
  effort: Schema.NullOr(TrimmedNonEmptyString),
  /** Name of the delegation preset that chose the target, when one did. */
  presetName: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type DelegationStartedPayload = typeof DelegationStartedPayload.Type;

/** Payload of `delegation.origin`, appended to the child thread. */
export const DelegationOriginPayload = Schema.Struct({
  parentThreadId: ThreadId,
});
export type DelegationOriginPayload = typeof DelegationOriginPayload.Type;

/** Common status rules for the parent UI and delegation tools. */
export function deriveDelegationStatus(shell: {
  readonly latestTurn: {
    readonly state: "running" | "completed" | "error" | "interrupted";
    readonly requestedAt: string;
  } | null;
  readonly session?: { readonly status: string; readonly updatedAt: string } | null | undefined;
  readonly latestUserMessageAt: string | null;
  readonly hasPendingTurnStart?: boolean | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}): "running" | "completed" | "error" | "interrupted" | "needs_user_action" {
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
  // A failed/cancelled follow-up is no longer pending, but still belongs to a
  // newer request than the previous completed turn.
  if (
    queuedAt !== null &&
    (turn === null || queuedAt > turn.requestedAt) &&
    shell.session &&
    shell.session.updatedAt >= queuedAt
  ) {
    if (shell.session.status === "error") return "error";
    if (shell.session.status === "stopped") return "interrupted";
  }
  const queued =
    shell.hasPendingTurnStart ??
    (queuedAt !== null && (turn === null || queuedAt > turn.requestedAt));
  if (queued) {
    const session = shell.session;
    if (session && (queuedAt === null || session.updatedAt >= queuedAt)) {
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
