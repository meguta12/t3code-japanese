import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import type { ServedModelReport } from "../components/chat/composerRunningModel";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The model the server reported for a turn (`turn.model-reported` activities).
 * The last report for the turn wins, so a provider reroute overrides the model
 * the turn started with. Returns null until the turn has reported one.
 */
export function deriveServedModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): ServedModelReport | null {
  if (!turnId) return null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "turn.model-reported" || activity.turnId !== turnId) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const model = nonEmptyString(payload?.model);
    if (model === null) continue;
    return { model, effort: nonEmptyString(payload?.effort) };
  }
  return null;
}
