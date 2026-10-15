import type { OrchestrationThreadShell } from "@t3tools/contracts";

export const RECENT_WORK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type RecentThreadInput = Pick<
  OrchestrationThreadShell,
  | "createdAt"
  | "archivedAt"
  | "settledOverride"
  | "latestUserMessageAt"
  | "latestTurn"
  | "session"
> & { readonly id: string; readonly environmentId: string };

export function isCompletedWork(
  thread: Pick<OrchestrationThreadShell, "settledOverride">,
  settlementSupported: boolean,
): boolean {
  // Match the original session sidebar: older environments must leave these
  // rows reachable when they cannot offer the command to reopen them.
  return settlementSupported && thread.settledOverride === "settled";
}

export function recentWorkActivityTimestamp(thread: RecentThreadInput): number | null {
  const workTimestamps = [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
    // Idle-session cleanup and reconnects are lifecycle metadata. Only an
    // agent that is starting/running can advance recency via its status stamp.
    ...(isWorkingThread(thread) ? [thread.session?.updatedAt] : []),
  ];
  const valid = workTimestamps
    .map((timestamp) => (timestamp == null ? NaN : Date.parse(timestamp)))
    .filter(Number.isFinite);
  if (valid.length > 0) return Math.max(...valid);
  const createdAt = Date.parse(thread.createdAt);
  // A title/model/PR metadata edit must not revive an inactive session.
  return Number.isFinite(createdAt) ? createdAt : null;
}

export function isWorkingThread(thread: Pick<OrchestrationThreadShell, "session">): boolean {
  return thread.session?.status === "running" || thread.session?.status === "starting";
}

export function recentWorkAgeLabel(activityAt: number, nowMs: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - activityAt) / 60_000));
  if (elapsedMinutes === 0) return "たった今";
  if (elapsedMinutes < 60) return `${elapsedMinutes}分前`;
  if (elapsedMinutes < 24 * 60) return `${Math.floor(elapsedMinutes / 60)}時間前`;
  return `${Math.floor(elapsedMinutes / (24 * 60))}日前`;
}

export function selectRecentWork<T extends RecentThreadInput>(
  threads: readonly T[],
  nowMs: number,
  completed: (thread: T) => boolean,
): T[] {
  return threads
    .filter((thread) => thread.archivedAt === null && !completed(thread))
    .map((thread) => ({ thread, activityAt: recentWorkActivityTimestamp(thread) }))
    .filter(
      ({ thread, activityAt }) =>
        isWorkingThread(thread) ||
        (activityAt !== null && activityAt <= nowMs && nowMs - activityAt < RECENT_WORK_RETENTION_MS),
    )
    .sort(
      (left, right) =>
        (right.activityAt ?? 0) - (left.activityAt ?? 0) ||
        left.thread.environmentId.localeCompare(right.thread.environmentId) ||
        left.thread.id.localeCompare(right.thread.id),
    )
    .map(({ thread }) => thread);
}

/** One deadline for the next disappearing row; active work has no deadline. */
export function nextRecentWorkExpiry(threads: readonly RecentThreadInput[], nowMs: number): number | null {
  const deadlines = threads.flatMap((thread) => {
    if (isWorkingThread(thread)) return [];
    const activityAt = recentWorkActivityTimestamp(thread);
    if (activityAt === null) return [];
    const expiresAt = activityAt + RECENT_WORK_RETENTION_MS;
    return expiresAt > nowMs ? [expiresAt] : [];
  });
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}
