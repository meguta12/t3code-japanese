import { ja } from "../../lib/ja";
import { useState } from "react";
import type { ProviderAuthMethod } from "@t3tools/contracts";
import { RadioGroup, Radio } from "../ui/radio-group";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";

export function ChatGptAccountPicker({
  open,
  methods,
  onClose,
  onSelect,
}: {
  open: boolean;
  methods: readonly ProviderAuthMethod[];
  onClose: () => void;
  onSelect: (methodId: string) => void;
}) {
  const profiles = methods.filter((method) => method.id.startsWith("chatgpt-profile:"));
  const [selection, setSelection] = useState<string | null>(null);
  const selectedMethodId =
    selection === "chatgpt-change-account"
      ? selection
      : (profiles.find((profile) => profile.id === selection)?.id ??
        profiles[0]?.id ??
        "chatgpt-change-account");
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>ChatGPTに再接続</DialogTitle>
          <DialogDescription>
            OpenAIのログイン画面で、ここで選んだアカウントを使ってください。
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-6">
          <RadioGroup
            aria-label="接続するChatGPTアカウント"
            value={selectedMethodId}
            onValueChange={(value) => setSelection(value)}
          >
            {ja(
              profiles.map((profile) => (
                <label
                  key={profile.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm"
                >
                  <Radio value={profile.id} />
                  <span className="min-w-0 break-all font-medium">{profile.name}</span>
                </label>
              )),
            )}
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm">
              <Radio value="chatgpt-change-account" />
              <span className="font-medium">別のアカウントを使う</span>
            </label>
          </RadioGroup>
        </div>
        <DialogFooter>
          <ChatGptConnectionButton onClick={() => onSelect(selectedMethodId)} />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
