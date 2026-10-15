import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo, useMemo } from "react";

import { useDelegationOrigin } from "../../state/delegation";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

/**
 * "◀ 委譲元: <parent title>" between the project and the title of a thread
 * another thread delegated to; opens the parent. Renders nothing for ordinary
 * threads, so the header stays as it was.
 */
export const DelegationOriginCrumb = memo(function DelegationOriginCrumb(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const navigate = useNavigate();
  const ref = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const origin = useDelegationOrigin(ref);
  if (origin === null) return null;
  const { parentThreadId, parentTitle } = origin;
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`委譲元のチャットを開く: ${parentTitle}`}
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams({ environmentId, threadId: parentThreadId }),
                  })
                }
                className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <WorkspaceBreadcrumbText className="max-w-56">
              ◀ 委譲元: {parentTitle}
            </WorkspaceBreadcrumbText>
          </TooltipTrigger>
          <TooltipPopup side="top">委譲元のチャットを開く: {parentTitle}</TooltipPopup>
        </Tooltip>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
});
