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
