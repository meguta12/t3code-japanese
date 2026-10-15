import { ja } from "../../lib/ja";
import { useAtomValue } from "@effect/atom-react";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { environmentPresentations } from "../../state/presentation";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { ChatGptUsageButton } from "./ChatGptUsageButton";

const STORAGE_KEY = "t3:chatgpt-sharing-welcome:v1";
function readAcknowledgedProfiles(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

/** Read the verified environment snapshot, never the browser callback acknowledgment. */
export function ChatGptWelcomeCoordinator() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [acknowledged, setAcknowledged] = useState(readAcknowledgedProfiles);
  const profiles = [...presentations].flatMap(([environmentId, presentation]) =>
    presentation.connection.phase !== "connected"
      ? []
      : (presentation.serverConfig?.providers ?? []).filter(usesChatGptSharing).map((provider) => ({
          key: JSON.stringify([
            environmentId,
            provider.instanceId,
            provider.auth.profileId ?? provider.auth.email ?? "default",
          ]),
          environmentLabel: presentation.entry.target.label,
          providerName: provider.displayName ?? "Codex",
        })),
  );
  const next = profiles.find((profile) => !acknowledged.includes(profile.key));
  const dismiss = () => {
    if (!next) return;
    const updated = [...acknowledged, next.key];
    setAcknowledged(updated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      /* Session dismissal still works. */
    }
  };
  return (
    <Dialog
      open={next !== undefined}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <OpenAI className="mb-2 size-8" aria-hidden="true" />
          <DialogTitle>ChatGPTのプランに接続済みです</DialogTitle>
          <DialogDescription>
            対象の処理はChatGPTのプラン枠を使います。共有の使用量やクレジット設定はChatGPTで管理してください。
          </DialogDescription>
          <p className="text-xs text-muted-foreground">
            {ja(next?.providerName)} {ja("on")}
            {ja(next?.environmentLabel)}
          </p>
        </DialogHeader>
        <DialogFooter>
          <ChatGptUsageButton />
          <Button onClick={dismiss}>続ける</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
