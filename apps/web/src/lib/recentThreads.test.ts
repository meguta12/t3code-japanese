import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnId } from "@t3tools/contracts";
import {
  isCompletedWork,
  nextRecentWorkExpiry,
  recentWorkActivityTimestamp,
  RECENT_WORK_RETENTION_MS,
  selectRecentWork,
  type RecentThreadInput,
} from "./recentThreads";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

function thread(overrides: Partial<RecentThreadInput> = {}): RecentThreadInput {
  return {
    id: "work",
    environmentId: "local",
    createdAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    latestUserMessageAt: "2026-10-03T12:00:00.000Z",
    latestTurn: null,
    session: null,
    ...overrides,
  };
}

const completed = (candidate: RecentThreadInput) => isCompletedWork(candidate, true);

describe("recent work", () => {
  it("orders by real work, including completion after an older user request", () => {
    const finished = thread({
      id: "finished",
      latestUserMessageAt: "2026-10-01T12:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn"),
        state: "completed",
        requestedAt: "2026-10-01T12:00:00.000Z",
        startedAt: "2026-10-01T12:00:01.000Z",
        completedAt: "2026-10-04T11:00:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(selectRecentWork([thread(), finished], NOW, completed).map(({ id }) => id)).toEqual([
      "finished",
      "work",
    ]);
  });

  it("expires at seven days, without removing history or mutating inputs", () => {
    const atBoundary = thread({ latestUserMessageAt: new Date(NOW - RECENT_WORK_RETENTION_MS).toISOString() });
    const justInside = thread({ id: "inside", latestUserMessageAt: new Date(NOW - RECENT_WORK_RETENTION_MS + 1).toISOString() });
    const input = [atBoundary, justInside];
    expect(selectRecentWork(input, NOW, completed)).toEqual([justInside]);
    expect(input).toEqual([atBoundary, justInside]);
  });

  it("does not renew work because a title, model, or PR metadata changed", () => {
    const renamed = {
      ...thread({ latestUserMessageAt: "2026-09-01T00:00:00.000Z" }),
      updatedAt: "2026-10-04T11:59:00.000Z",
    };
    expect(recentWorkActivityTimestamp(renamed)).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
    expect(selectRecentWork([renamed], NOW, completed)).toEqual([]);
  });

  it("keeps long-running work visible and creates no expiry timer for it", () => {
    const running = thread({
      latestUserMessageAt: "2026-09-01T00:00:00.000Z",
      session: {
        threadId: ThreadId.make("work"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn"),
        lastError: null,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(selectRecentWork([running], NOW, completed)).toEqual([running]);
    expect(nextRecentWorkExpiry([running], NOW)).toBeNull();
  });

  it.each(["stopped", "ready", "idle"] as const)(
    "does not revive stale work when a %s session gets a new lifecycle stamp",
    (status) => {
      const stale = thread({
        latestUserMessageAt: "2026-09-01T00:00:00.000Z",
        session: {
          threadId: ThreadId.make("work"),
          status,
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-10-04T11:59:00.000Z",
        },
      });
      expect(selectRecentWork([stale], NOW, completed)).toEqual([]);
    },
  );

  it("excludes archived and completed work while keeping old-server threads reachable", () => {
    const closed = thread({ id: "settled", settledOverride: "settled" });
    const archived = thread({ id: "archive", archivedAt: "2026-10-03T12:00:00.000Z" });
    expect(selectRecentWork([closed, archived, thread()], NOW, completed).map(({ id }) => id)).toEqual(["work"]);
    expect(selectRecentWork([closed], NOW, (candidate) => isCompletedWork(candidate, false))).toEqual([closed]);
  });

  it("preserves sessions with the same id on different environments", () => {
    const remote = thread({ environmentId: "remote" });
    const local = thread();
    expect(selectRecentWork([remote, local], NOW, completed)).toEqual([local, remote]);
  });

  it("uses creation for empty sessions and rejects malformed or future work times", () => {
    const empty = thread({ createdAt: "2026-10-03T10:00:00.000Z", latestUserMessageAt: null });
    const malformed = thread({ createdAt: "invalid", latestUserMessageAt: "invalid" });
    const future = thread({ latestUserMessageAt: "2026-10-05T12:00:00.000Z" });
    expect(selectRecentWork([empty, malformed, future], NOW, completed)).toEqual([empty]);
  });

  it("returns the first expiry deadline and skips deadlines that have passed", () => {
    const earlier = thread({ latestUserMessageAt: "2026-09-28T12:00:00.000Z" });
    const later = thread();
    expect(nextRecentWorkExpiry([later, earlier], NOW)).toBe(Date.parse("2026-10-05T12:00:00.000Z"));
    expect(nextRecentWorkExpiry([earlier], Date.parse("2026-10-05T12:00:00.000Z"))).toBeNull();
  });
});
