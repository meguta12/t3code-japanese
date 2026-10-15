import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { useDelegatedRuns, useDelegationOrigin } from "../../state/delegation";
import { buildThreadRouteParams } from "../../threadRoutes";

/**
 * What the composer strip needs to show the threads this thread delegated to:
 * the runs (each child's status follows its own thread shell) and a way to
 * open one.
 */
export function useDelegatedRunsStrip(threadRef: ScopedThreadRef) {
  const navigate = useNavigate();
  const origin = useDelegationOrigin(threadRef);
  const rootRef = useMemo(
    () =>
      origin
        ? { environmentId: threadRef.environmentId, threadId: origin.parentThreadId }
        : threadRef,
    [threadRef, origin],
  );
  const delegatedRuns = useDelegatedRuns(rootRef);
  const { environmentId } = threadRef;
  const onOpenDelegatedThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId }),
      });
    },
    [environmentId, navigate],
  );
  return { delegatedRuns, onOpenDelegatedThread, origin };
}
