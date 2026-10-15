import { FolderTreeIcon, LayoutListIcon } from "lucide-react";
import { useState } from "react";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function SidebarViewModeSwitch() {
  const folderMode = useClientSettings((settings) => settings.legacySidebarEnabled);
  const hydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();
  const [pending, setPending] = useState(false);

  const changeMode = async (nextFolderMode: boolean) => {
    if (pending || nextFolderMode === folderMode) return;
    setPending(true);
    try {
      await updateSettings({ legacySidebarEnabled: nextFolderMode });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "表示モードを保存できませんでした",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-wrap gap-1 px-3 py-1.5" role="group" aria-label="作業一覧の表示モード">
      <Button
        variant={folderMode ? "secondary" : "ghost"}
        size="xs"
        aria-pressed={folderMode}
        disabled={!hydrated || pending}
        onClick={() => void changeMode(true)}
      >
        <FolderTreeIcon className="size-3.5" />
        フォルダー表示
      </Button>
      <Button
        variant={folderMode ? "ghost" : "secondary"}
        size="xs"
        aria-pressed={!folderMode}
        disabled={!hydrated || pending}
        onClick={() => void changeMode(false)}
      >
        <LayoutListIcon className="size-3.5" />
        T3標準表示
      </Button>
    </div>
  );
}
