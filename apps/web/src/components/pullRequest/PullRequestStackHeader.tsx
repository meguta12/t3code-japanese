import { ja, jaTemplate } from "../../lib/ja";
import { MenuGroupLabel } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function PullRequestStackHeader({
  number,
  notice,
  stale = false,
}: {
  number: number;
  notice?: string | null | undefined;
  stale?: boolean;
}) {
  return (
    <MenuGroupLabel>
      <div className="flex items-center justify-between gap-2">
        <span>{jaTemplate`Stack #${number}`}</span>
        {notice ? (
          <Tooltip>
            <TooltipTrigger render={<span role="status" className="text-xs font-normal" />}>
              {stale ? ja("May be stale") : "更新中…"}
            </TooltipTrigger>
            <TooltipPopup>{ja(notice)}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </MenuGroupLabel>
  );
}
