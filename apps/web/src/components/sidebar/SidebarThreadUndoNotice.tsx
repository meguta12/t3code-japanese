import { ja, jaTemplate } from "../../lib/ja";
import { useAtomValue } from "@effect/atom-react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { InlineButton } from "../ui/button";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!notice) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");

  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        {notice.action} {notice.count} {ja("thread")}
        {notice.count === 1 ? "" : "s"},{" "}
        <InlineButton onClick={undoLatestThreadAction}>
          {shortcut ? jaTemplate`${shortcut} to undo` : "元に戻す"}
        </InlineButton>
      </AlertDescription>
    </Alert>
  );
}
