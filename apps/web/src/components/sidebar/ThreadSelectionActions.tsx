import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import type { useThreadActions } from "~/hooks/useThreadActions";
import {
  planBulkReopen,
  planBulkSettle,
  summarizeBulkReopen,
  summarizeBulkSettle,
  type BulkThreadEntry,
} from "~/lib/threadCompletion";
import { readLocalApi } from "../../localApi";
import { readEnvironmentSupportsSettlement, readThreadShell } from "../../state/entities";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../../threadSelectionStore";
import { useUiStateStore } from "../../uiStateStore";
import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
  deleteSelectedThreadEntries,
} from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ThreadSelectionActions } from "./threadSelectionActionsContext";

/** Builds the selection actions shared by the menu, the selection bar and the Recent / Completed rows. */

type ThreadActions = ReturnType<typeof useThreadActions>;

const selectionStore = () => useThreadSelectionStore.getState();

function readSelectedEntries() {
  const threadKeys = [...selectionStore().selectedThreadKeys];
  return threadKeys.flatMap((threadKey) => {
    const threadRef = parseScopedThreadKey(threadKey);
    const thread = threadRef ? readThreadShell(threadRef) : null;
    return threadRef && thread ? [{ threadKey, threadRef, thread }] : [];
  });
}

function toBulkEntries(
  entries: ReadonlyArray<{ threadKey: string; threadRef: ScopedThreadRef }>,
): BulkThreadEntry[] {
  return entries.map(({ threadKey, threadRef }) => ({
    threadKey,
    thread: readThreadShell(threadRef),
    supportsSettlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
  }));
}

function reportFailure(title: string, failure: unknown) {
  const error = squashAtomCommandFailure(failure as never);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "操作に失敗しました。",
    }),
  );
}

export function useBuildThreadSelectionActions(
  deps: Pick<ThreadActions, "archiveThread" | "deleteThread" | "settleThread" | "unsettleThread">,
): ThreadSelectionActions {
  const confirmArchive = useClientSettings<boolean>((settings) => settings.confirmThreadArchive);
  const confirmDelete = useClientSettings<boolean>((settings) => settings.confirmThreadDelete);
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  // Rows consume this through context, so the returned object has to stay
  // stable; the handlers read the latest inputs from this ref instead.
  const latest = useRef({ deps, confirmArchive, confirmDelete, markThreadUnread });
  useEffect(() => {
    latest.current = { deps, confirmArchive, confirmDelete, markThreadUnread };
  });
  const busyRef = useRef(false);

  return useMemo<ThreadSelectionActions>(() => {
    const clearSelection = () => selectionStore().clearSelection();
    const removeFromSelection = (threadKeys: readonly string[]) =>
      selectionStore().removeFromSelection(threadKeys);

    const reopenRefs = async (refs: readonly ScopedThreadRef[]) => {
      let reopened = 0;
      let failed = 0;
      for (const ref of refs) {
        const result = await latest.current.deps.unsettleThread(ref);
        if (result._tag === "Success") reopened += 1;
        else if (!isAtomCommandInterrupted(result)) failed += 1;
      }
      toastManager.add(
        stackedThreadToast({
          type: failed > 0 ? "warning" : "success",
          title: summarizeBulkReopen({ reopened, failed }),
        }),
      );
    };

    const completeSelected = async () => {
      if (busyRef.current) return;
      const entries = readSelectedEntries();
      const plan = planBulkSettle(toBulkEntries(entries), new Date().toISOString());
      const refByKey = new Map(entries.map((entry) => [entry.threadKey, entry.threadRef]));
      busyRef.current = true;
      try {
        const settledRefs: ScopedThreadRef[] = [];
        let failed = 0;
        for (const threadKey of plan.eligible) {
          const ref = refByKey.get(threadKey);
          if (!ref) continue;
          // Each settle registers its own sidebar Undo; consecutive ones are
          // grouped into a single notice by showThreadUndoNotice.
          const result = await latest.current.deps.settleThread(ref);
          if (result._tag === "Success") settledRefs.push(ref);
          else if (!isAtomCommandInterrupted(result)) failed += 1;
        }
        removeFromSelection(settledRefs.map(scopedThreadKey));
        if (failed === 0 && settledRefs.length > 0) clearSelection();
        toastManager.add(
          stackedThreadToast({
            type: failed > 0 || settledRefs.length === 0 ? "warning" : "success",
            title: summarizeBulkSettle({
              settled: settledRefs.length,
              alreadySettled: plan.alreadySettled.length,
              blocked: plan.blocked.length,
              failed,
            }),
            ...(settledRefs.length > 0
              ? {
                  timeout: 8_000,
                  actionProps: {
                    children: "元に戻す",
                    // Reopens exactly the threads settled by this action.
                    onClick: () => {
                      void reopenRefs(
                        settledRefs.filter(
                          (ref) => readThreadShell(ref)?.settledOverride === "settled",
                        ),
                      );
                    },
                  },
                }
              : {}),
          }),
        );
      } finally {
        busyRef.current = false;
      }
    };

    const reopenSelected = async () => {
      if (busyRef.current) return;
      const entries = readSelectedEntries();
      const plan = planBulkReopen(toBulkEntries(entries));
      const refByKey = new Map(entries.map((entry) => [entry.threadKey, entry.threadRef]));
      busyRef.current = true;
      try {
        await reopenRefs(plan.eligible.flatMap((key) => refByKey.get(key) ?? []));
        clearSelection();
      } finally {
        busyRef.current = false;
      }
    };

    const archiveSelected = async () => {
      const api = readLocalApi();
      if (!api) return;
      const entries = readSelectedEntries();
      if (entries.length === 0) return;
      if (latest.current.confirmArchive) {
        const confirmed = await api.dialogs.confirm(`${entries.length}件の会話をアーカイブしますか？`);
        if (!confirmed) return;
      }
      const archiveOutcome = await archiveSelectedThreadEntries({
        entries,
        archive: ({ threadRef }, onArchived) =>
          latest.current.deps.archiveThread(threadRef, { onArchived }),
      });
      for (const failure of archiveOutcome.followupFailures) {
        if (isAtomCommandInterrupted(failure)) continue;
        reportFailure("アーカイブしましたが、画面を切り替えられませんでした", failure);
      }
      if (archiveOutcome.mutationFailure) {
        removeFromSelection(archiveOutcome.archivedThreadKeys);
        if (!isAtomCommandInterrupted(archiveOutcome.mutationFailure)) {
          reportFailure("アーカイブできませんでした", archiveOutcome.mutationFailure);
        }
        return;
      }
      removeFromSelection(entries.map((entry) => entry.threadKey));
    };

    const showSelectionMenu = async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...selectionStore().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const selectedThreadEntries = readSelectedEntries();
      const hasRunningThread = selectedThreadEntries.some(
        ({ thread }) => thread.session?.status === "running" && thread.session.activeTurnId != null,
      );
      const bulkEntries = toBulkEntries(selectedThreadEntries);

      const clicked = await api.contextMenu.show(
        buildMultiSelectThreadContextMenuItems({
          count,
          hasRunningThread,
          settleCount: planBulkSettle(bulkEntries, new Date().toISOString()).eligible.length,
          reopenCount: planBulkReopen(bulkEntries).eligible.length,
        }),
        position,
      );

      if (clicked === "complete") return completeSelected();
      if (clicked === "reopen") return reopenSelected();

      if (clicked === "mark-unread") {
        for (const { threadKey, thread } of selectedThreadEntries) {
          latest.current.markThreadUnread(threadKey, thread.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked === "archive") return archiveSelected();

      if (clicked !== "delete") return;

      if (latest.current.confirmDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `${count}件の会話を削除しますか？`,
            "これらの会話の履歴が完全に消去されます。",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }

      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: selectedThreadEntries,
        delete: ({ threadRef }, deletedThreadKeys) =>
          latest.current.deps.deleteThread(threadRef, { deletedThreadKeys }),
      });
      if (firstFailure !== null) {
        reportFailure("会話を削除できませんでした", firstFailure);
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(threadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    };

    return { showSelectionMenu, completeSelected, reopenSelected, archiveSelected };
  }, []);
}
