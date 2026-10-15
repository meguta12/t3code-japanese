import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  planBulkReopen,
  planBulkSettle,
  summarizeBulkReopen,
  summarizeBulkSettle,
  type BulkThreadEntry,
} from "./threadCompletion";

const NOW = "2026-10-04T12:00:00.000Z";

function entry(
  threadKey: string,
  overrides: Partial<EnvironmentThreadShell> | null,
  supportsSettlement = true,
): BulkThreadEntry {
  return {
    threadKey,
    supportsSettlement,
    thread:
      overrides === null
        ? null
        : ({
            archivedAt: null,
            settledOverride: null,
            session: null,
            backgroundLiveness: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            latestUserMessageAt: null,
            latestTurn: null,
            ...overrides,
          } as unknown as EnvironmentThreadShell),
  };
}

describe("planBulkSettle", () => {
  it("separates settleable, already settled and blocked threads", () => {
    const plan = planBulkSettle(
      [
        entry("idle", {}),
        entry("done", { settledOverride: "settled" }),
        entry("running", { session: { status: "running" } as never }),
        entry("approval", { hasPendingApprovals: true }),
        entry("question", { hasPendingUserInput: true }),
        entry("archived", { archivedAt: "2026-10-01T00:00:00.000Z" }),
        entry("old-server", {}, false),
        entry("gone", null),
      ],
      NOW,
    );
    expect(plan.eligible).toEqual(["idle"]);
    expect(plan.alreadySettled).toEqual(["done"]);
    expect(plan.blocked).toEqual(["running", "approval", "question", "archived", "old-server"]);
  });

  it("blocks a thread whose message was just sent and has not started", () => {
    const plan = planBulkSettle(
      [entry("queued", { latestUserMessageAt: "2026-10-04T11:59:59.000Z" })],
      NOW,
    );
    expect(plan.eligible).toEqual([]);
    expect(plan.blocked).toEqual(["queued"]);
  });
});

describe("planBulkReopen", () => {
  it("reopens only settled threads on environments that support it", () => {
    const plan = planBulkReopen([
      entry("done", { settledOverride: "settled" }),
      entry("active", {}),
      entry("old-server", { settledOverride: "settled" }, false),
      entry("gone", null),
    ]);
    expect(plan.eligible).toEqual(["done"]);
    expect(plan.notSettled).toEqual(["active"]);
  });
});

describe("bulk summaries", () => {
  it("reports skipped threads next to the settled count", () => {
    expect(summarizeBulkSettle({ settled: 5, alreadySettled: 0, blocked: 2, failed: 0 })).toBe(
      "5件を完了にしました（2件は実行中などのため対象外）",
    );
    expect(summarizeBulkSettle({ settled: 3, alreadySettled: 1, blocked: 1, failed: 1 })).toBe(
      "3件を完了にしました（1件は実行中などのため対象外、1件は完了済み、1件は失敗）",
    );
    expect(summarizeBulkSettle({ settled: 4, alreadySettled: 0, blocked: 0, failed: 0 })).toBe(
      "4件を完了にしました",
    );
  });

  it("says so when nothing could be settled or reopened", () => {
    expect(summarizeBulkSettle({ settled: 0, alreadySettled: 0, blocked: 3, failed: 0 })).toBe(
      "完了にできた会話はありません（3件は実行中などのため対象外）",
    );
    expect(summarizeBulkReopen({ reopened: 2, failed: 1 })).toBe("2件を再開しました（1件は失敗）");
    expect(summarizeBulkReopen({ reopened: 0, failed: 0 })).toBe("再開できた会話はありません");
  });
});
