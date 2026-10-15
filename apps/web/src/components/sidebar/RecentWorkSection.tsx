import { groupDelegationThreads, visibleDelegationThreads } from "../../lib/delegationGroups";
import {
  DelegationThreadGroup,
  DelegationRoleBadge,
  useDelegationTreeStore,
} from "./DelegationThreadGroup";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";

import { useProjects } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { cn, isMacPlatform } from "../../lib/utils";
import {
  isCompletedWork,
  isWorkingThread,
  nextRecentWorkExpiry,
  recentWorkAgeLabel,
  recentWorkActivityTimestamp,
  selectRecentWork,
} from "../../lib/recentThreads";
import { resolveThreadRowClickIntent, useThreadSelectionStore } from "../../threadSelectionStore";
import { SidebarGroup } from "../ui/sidebar";
import { ProviderThreadIcon } from "./ProviderThreadIcon";
import { useOptionalThreadSelectionActions } from "./threadSelectionActionsContext";

const INITIAL_RECENT_WORK_COUNT = 5;

export function RecentWorkSection({
  threads,
  onNavigateToThread,
}: {
  threads: readonly EnvironmentThreadShell[];
  onNavigateToThread: (threadRef: ScopedThreadRef) => void | Promise<void>;
}) {
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const routeTarget = useParams({ strict: false, select: resolveThreadRouteTarget });
  const activeKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const [nowMs, setNowMs] = useState(Date.now);
  const [expanded, setExpanded] = useState(false);
  const recent = useMemo(
    () =>
      selectRecentWork(threads, nowMs, (thread) =>
        isCompletedWork(
          thread,
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
            true,
        ),
      ),
    [nowMs, serverConfigs, threads],
  );
  useEffect(() => {
    let timer: number | null = null;
    const refresh = () => {
      const observedAt = Date.now();
      setNowMs(observedAt);
      const current = selectRecentWork(threads, observedAt, (thread) =>
        isCompletedWork(
          thread,
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
            true,
        ),
      );
      const nextExpiry = nextRecentWorkExpiry(current, observedAt);
      if (timer !== null) window.clearTimeout(timer);
      timer =
        nextExpiry === null
          ? null
          : window.setTimeout(refresh, Math.max(1, nextExpiry - observedAt));
    };
    // Activity and returning to the app refresh the clock; otherwise one
    // deadline removes the next expired row without an ongoing polling loop.
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [serverConfigs, threads]);
  const projectNames = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const visible = expanded ? recent : recent.slice(0, INITIAL_RECENT_WORK_COUNT);
  const collapsedFamilies = useDelegationTreeStore((state) => state.collapsedFamilies);
  const groups = groupDelegationThreads(visible);
  const orderedVisible = visibleDelegationThreads(
    groups.flatMap((group) => group.members),
    collapsedFamilies,
  );
  // Selection is only wired up where a selection-actions provider exists (the
  // folder view); elsewhere these rows keep their plain click-to-open behavior.
  const selectionActions = useOptionalThreadSelectionActions();
  const selectedThreadKeys = useThreadSelectionStore((state) => state.selectedThreadKeys);
  const handleRowClick = (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
    const store = useThreadSelectionStore.getState();
    const key = scopedThreadKey(threadRef);
    const intent =
      selectionActions === null
        ? "navigate"
        : resolveThreadRowClickIntent({
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            isMac: isMacPlatform(navigator.platform),
          });
    if (intent === "toggle") {
      event.preventDefault();
      store.toggleThread(key);
      return;
    }
    if (intent === "range") {
      event.preventDefault();
      store.rangeSelectTo(
        key,
        orderedVisible.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      );
      return;
    }
    if (store.hasSelection()) store.clearSelection();
    store.setAnchor(key);
    void onNavigateToThread(threadRef);
  };
  const handleRowContextMenu = (event: ReactMouseEvent, key: string) => {
    if (
      selectionActions === null ||
      !useThreadSelectionStore.getState().selectedThreadKeys.has(key)
    ) {
      return;
    }
    event.preventDefault();
    void selectionActions.showSelectionMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <SidebarGroup data-testid="sidebar-recent-work">
      <h3 className="px-2 pb-1 text-xs font-medium text-sidebar-muted-foreground">最近の作業</h3>
      {visible.length === 0 ? (
        <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
          直近1週間の作業はありません
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {groups.map((group) => {
            const rows = group.members.map((thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const key = scopedThreadKey(threadRef);
              const activityAt = recentWorkActivityTimestamp(thread);
              const projectName =
                projectNames.get(`${thread.environmentId}:${thread.projectId}`) ?? "";
              return (
                <li key={key}>
                  <button
                    type="button"
                    aria-label={`最近の作業: ${thread.title} (${projectName})`}
                    data-testid={`recent-work-${key}`}
                    data-active={activeKey === key}
                    data-selected={selectedThreadKeys.has(key)}
                    data-thread-selection-safe
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                      activeKey === key || selectedThreadKeys.has(key)
                        ? "bg-sidebar-row-active"
                        : "hover:bg-sidebar-row-hover",
                    )}
                    onClick={(event) => handleRowClick(event, threadRef)}
                    onContextMenu={(event) => handleRowContextMenu(event, key)}
                  >
                    <ProviderThreadIcon thread={thread} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-sidebar-foreground">
                        <DelegationRoleBadge
                          role={
                            group.isFamily
                              ? thread.delegationParentThreadId
                                ? "child"
                                : "parent"
                              : undefined
                          }
                        />
                        {thread.title}
                      </span>
                      <span className="truncate text-xs text-sidebar-muted-foreground">
                        {projectName}
                      </span>
                    </span>
                    <span className="shrink-0 text-3xs text-sidebar-muted-foreground">
                      {isWorkingThread(thread)
                        ? "実行中"
                        : activityAt === null
                          ? ""
                          : recentWorkAgeLabel(activityAt, nowMs)}
                    </span>
                  </button>
                </li>
              );
            });
            return group.isFamily ? (
              <DelegationThreadGroup
                key={group.key}
                familyKey={group.key}
                hasParent={group.members.some((member) => member.delegationParentThreadId == null)}
                asListItem
              >
                {rows}
              </DelegationThreadGroup>
            ) : (
              rows
            );
          })}
        </ul>
      )}
      {recent.length > INITIAL_RECENT_WORK_COUNT ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="cursor-pointer px-2 pt-1 text-left text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
          aria-expanded={expanded}
        >
          {expanded
            ? "少なく表示する"
            : `もっと表示する (${recent.length - INITIAL_RECENT_WORK_COUNT})`}
        </button>
      ) : null}
    </SidebarGroup>
  );
}
