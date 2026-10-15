import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useEffect, useMemo } from "react";

import { planBulkReopen, planBulkSettle, type BulkThreadEntry } from "~/lib/threadCompletion";
import { readEnvironmentSupportsSettlement } from "../../state/entities";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { shouldClearThreadSelectionOnEscape } from "../Sidebar.logic";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { useOptionalThreadSelectionActions } from "./threadSelectionActionsContext";

/**
 * Visible entry point for bulk actions while threads are selected, so nobody
 * has to know the right-click menu exists. Only actions that apply to the
 * current (possibly mixed) selection are offered, each with its own count.
 */
export function ThreadSelectionBar({ threads }: { threads: readonly EnvironmentThreadShell[] }) {
  const selectionSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);

  useEffect(() => {
    if (selectionSize === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        shouldClearThreadSelectionOnEscape({
          key: event.key,
          defaultPrevented: event.defaultPrevented,
          target: event.target instanceof HTMLElement ? event.target : null,
        })
      ) {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection, selectionSize]);

  if (selectionSize === 0) return null;
  return <ThreadSelectionBarContent threads={threads} />;
}

function ThreadSelectionBarContent({ threads }: { threads: readonly EnvironmentThreadShell[] }) {
  const actions = useOptionalThreadSelectionActions();
  const selectedThreadKeys = useThreadSelectionStore((state) => state.selectedThreadKeys);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const threadByKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread,
        ]),
      ),
    [threads],
  );
  const entries = useMemo<BulkThreadEntry[]>(
    () =>
      [...selectedThreadKeys].flatMap((threadKey) => {
        const thread = threadByKey.get(threadKey);
        return thread
          ? [
              {
                threadKey,
                thread,
                supportsSettlement: readEnvironmentSupportsSettlement(thread.environmentId),
              },
            ]
          : [];
      }),
    [selectedThreadKeys, threadByKey],
  );
  if (actions === null) return null;
  const settleCount = planBulkSettle(entries, new Date().toISOString()).eligible.length;
  const reopenCount = planBulkReopen(entries).eligible.length;
  // Same rule as the right-click menu: a running thread cannot be archived.
  const hasRunningThread = entries.some(
    ({ thread }) => thread?.session?.status === "running" && thread.session.activeTurnId != null,
  );

  return (
    <div className="px-2 pb-1" data-thread-selection-safe data-testid="sidebar-selection-bar">
      <Alert variant="sidebar">
        <AlertDescription>
          <span className="font-medium">{selectedThreadKeys.size}件選択中</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {settleCount > 0 ? (
              <Button size="xs" variant="outline" onClick={() => void actions.completeSelected()}>
                完了（{settleCount}）
              </Button>
            ) : null}
            {reopenCount > 0 ? (
              <Button size="xs" variant="outline" onClick={() => void actions.reopenSelected()}>
                まとめて再開（{reopenCount}）
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={hasRunningThread}
              onClick={() => void actions.archiveSelected()}
            >
              アーカイブ
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={clearSelection}>
              選択解除
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    </div>
  );
}
