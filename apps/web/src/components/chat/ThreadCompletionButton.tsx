import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  effectiveSnoozed,
  QUEUED_TURN_START_GRACE_MS,
} from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useThreadActions } from "~/hooks/useThreadActions";
import { threadCompletionBlockReason } from "~/lib/threadCompletion";
import {
  readEnvironmentSupportsSettlement,
  readThreadShell,
  readThreadShells,
  useServerConfigs,
  useThreadShell,
} from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { shouldNavigateAfterThreadPark } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export { threadCompletionBlockReason };

export function findNextThreadAfterCompletion(
  completed: EnvironmentThreadShell,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string,
): EnvironmentThreadShell | null {
  return (
    threads
      .filter(
        (thread) =>
          thread.environmentId === completed.environmentId &&
          thread.projectId === completed.projectId &&
          thread.id !== completed.id &&
          thread.archivedAt == null &&
          thread.settledOverride !== "settled" &&
          !effectiveSnoozed(thread, { now }),
      )
      .toSorted((left, right) =>
        (right.latestUserMessageAt ?? right.updatedAt).localeCompare(
          left.latestUserMessageAt ?? left.updatedAt,
        ),
      )[0] ?? null
  );
}

export function ThreadCompletionButton({
  threadRef,
  compact,
}: {
  threadRef: ScopedThreadRef;
  compact: boolean;
}) {
  const thread = useThreadShell(threadRef);
  const configs = useServerConfigs();
  const router = useRouter();
  const { settleThread, unsettleThread } = useThreadActions();
  const handleNewThread = useNewThreadHandler();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [, refreshQueuedState] = useState(0);
  const queuedMessageAt = thread?.latestUserMessageAt;
  useEffect(() => {
    if (!queuedMessageAt) return;
    const remaining = Date.parse(queuedMessageAt) + QUEUED_TURN_START_GRACE_MS - Date.now();
    if (!Number.isFinite(remaining) || remaining < 0) return;
    const timer = setTimeout(() => refreshQueuedState((value) => value + 1), remaining + 1);
    return () => clearTimeout(timer);
  }, [queuedMessageAt]);

  if (
    !thread ||
    configs.get(threadRef.environmentId)?.environment.capabilities.threadSettlement !== true
  ) {
    return null;
  }
  const settled = thread.settledOverride === "settled";
  const label = settled ? "作業を再開" : "作業を完了";
  const reason = settled ? null : threadCompletionBlockReason(thread, new Date().toISOString());
  const disabled = pending || reason !== null;
  const explanation =
    reason ??
    (settled
      ? "この会話を作業一覧へ戻します。"
      : "作業一覧から外します。会話は完了した作業から再開できます。");

  const onClick = async () => {
    if (pendingRef.current || !readEnvironmentSupportsSettlement(threadRef.environmentId)) return;
    const current = readThreadShell(threadRef);
    if (!current) return;
    const reopening = current.settledOverride === "settled";
    if (!reopening && threadCompletionBlockReason(current, new Date().toISOString())) return;
    const requestedHref = router.state.location.href;
    let completedSuccessfully = false;
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await (reopening ? unsettleThread(threadRef) : settleThread(threadRef));
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          throw squashAtomCommandFailure(result);
        }
        return;
      }
      completedSuccessfully = !reopening;
      if (reopening || router.state.location.href !== requestedHref) return;
      const now = new Date().toISOString();
      const currentThread = readThreadShell(threadRef);
      const threadKey = scopedThreadKey(threadRef);
      if (
        !shouldNavigateAfterThreadPark({
          threadKey,
          currentThreadKey: threadKey,
          action: "settle",
          now,
          thread: currentThread,
        })
      ) {
        return;
      }
      const next = findNextThreadAfterCompletion(current, readThreadShells(), now);
      if (next) {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(next.environmentId, next.id)),
        });
      } else {
        await handleNewThread(scopeProjectRef(current.environmentId, current.projectId));
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: completedSuccessfully
            ? "作業は完了しましたが、画面を切り替えられませんでした"
            : settled
              ? "作業を再開できませんでした"
              : "作業を完了できませんでした",
          description: error instanceof Error ? error.message : "操作に失敗しました。",
        }),
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" tabIndex={disabled ? 0 : undefined} />}>
        <Button
          size={compact ? "icon-sm" : "sm"}
          variant="outline"
          disabled={disabled}
          aria-label={label}
          aria-busy={pending}
          onClick={onClick}
        >
          {settled ? <RotateCcwIcon /> : <CheckIcon />}
          {!compact ? <span>{label}</span> : null}
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{explanation}</TooltipPopup>
    </Tooltip>
  );
}
