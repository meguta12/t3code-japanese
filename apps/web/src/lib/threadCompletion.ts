/**
 * Pure decisions for "complete" / "reopen" on one thread or a selection of them.
 * Shared by the chat-header button and the sidebar bulk actions so both agree
 * on which threads can be settled and how the outcome is worded.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { hasQueuedTurnStart } from "@t3tools/client-runtime/state/thread-settled";

export function threadCompletionBlockReason(
  thread: EnvironmentThreadShell,
  now: string,
): string | null {
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return "エージェントが作業中です。作業が止まってから完了できます。";
  }
  if (thread.backgroundLiveness != null) {
    return "サブエージェントが作業中です。作業が止まってから完了できます。";
  }
  if (thread.hasPendingApprovals) {
    return "承認待ちの操作があります。承認するか、作業を停止してください。";
  }
  if (thread.hasPendingUserInput) {
    return "回答待ちの質問があります。回答するか、作業を停止してください。";
  }
  if (hasQueuedTurnStart(thread, { now })) {
    return "送信したメッセージの開始待ちです。開始するまでお待ちください。";
  }
  return null;
}

export interface BulkThreadEntry {
  readonly threadKey: string;
  /** Null when the thread no longer exists in the local read model. */
  readonly thread: EnvironmentThreadShell | null;
  /** Whether the thread's environment accepts settle/unsettle commands. */
  readonly supportsSettlement: boolean;
}

export interface BulkSettlePlan {
  /** Threads to settle now. */
  readonly eligible: readonly string[];
  readonly alreadySettled: readonly string[];
  /** Running, waiting on the user, queued, archived, or on an environment without settlement. */
  readonly blocked: readonly string[];
}

export function planBulkSettle(entries: readonly BulkThreadEntry[], now: string): BulkSettlePlan {
  const eligible: string[] = [];
  const alreadySettled: string[] = [];
  const blocked: string[] = [];
  for (const { threadKey, thread, supportsSettlement } of entries) {
    if (thread === null) continue;
    if (thread.settledOverride === "settled") {
      alreadySettled.push(threadKey);
    } else if (
      !supportsSettlement ||
      thread.archivedAt != null ||
      threadCompletionBlockReason(thread, now) !== null
    ) {
      blocked.push(threadKey);
    } else {
      eligible.push(threadKey);
    }
  }
  return { eligible, alreadySettled, blocked };
}

export interface BulkReopenPlan {
  /** Settled threads that can be reopened. */
  readonly eligible: readonly string[];
  /** Threads that are not settled, so there is nothing to reopen. */
  readonly notSettled: readonly string[];
}

export function planBulkReopen(entries: readonly BulkThreadEntry[]): BulkReopenPlan {
  const eligible: string[] = [];
  const notSettled: string[] = [];
  for (const { threadKey, thread, supportsSettlement } of entries) {
    if (thread === null) continue;
    if (thread.settledOverride === "settled" && supportsSettlement) {
      eligible.push(threadKey);
    } else if (thread.settledOverride !== "settled") {
      notSettled.push(threadKey);
    }
  }
  return { eligible, notSettled };
}

function skippedNote(parts: ReadonlyArray<string | null>): string {
  const present = parts.filter((part): part is string => part !== null);
  return present.length === 0 ? "" : `（${present.join("、")}）`;
}

export function summarizeBulkSettle(input: {
  settled: number;
  alreadySettled: number;
  blocked: number;
  failed: number;
}): string {
  const note = skippedNote([
    input.blocked > 0 ? `${input.blocked}件は実行中などのため対象外` : null,
    input.alreadySettled > 0 ? `${input.alreadySettled}件は完了済み` : null,
    input.failed > 0 ? `${input.failed}件は失敗` : null,
  ]);
  if (input.settled === 0) return `完了にできた会話はありません${note}`;
  return `${input.settled}件を完了にしました${note}`;
}

export function summarizeBulkReopen(input: { reopened: number; failed: number }): string {
  const note = skippedNote([input.failed > 0 ? `${input.failed}件は失敗` : null]);
  if (input.reopened === 0) return `再開できた会話はありません${note}`;
  return `${input.reopened}件を再開しました${note}`;
}
