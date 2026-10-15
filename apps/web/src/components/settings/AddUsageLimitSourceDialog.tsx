import { ja } from "../../lib/ja";
import { type EnvironmentId, UsageLimitSourceId } from "@t3tools/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * Stable per hub and readable in settings.json. Dots and dashes in the host
 * are kept so `foo-bar.com` and `foo.bar.com` do not collide; anything else
 * (a port's colon, a path) is folded to a dash.
 */
function sourceIdFromUrl(url: string): UsageLimitSourceId {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw text; the server reports the bad URL on its row.
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return UsageLimitSourceId.make(`cliproxy-${slug || "hub"}`);
}

/**
 * Adds a CLIProxyAPI hub from provider settings on one environment. The
 * management key is sent once and kept in that server's secret store;
 * settings only ever carry a redaction marker for it afterwards.
 */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const trimmedUrl = url.trim();
  const canSave = trimmedUrl.length > 0 && managementKey.trim().length > 0;

  const reset = () => {
    setLabel("");
    setUrl("");
    setManagementKey("");
  };

  const save = () => {
    if (!canSave) return;
    const id = sourceIdFromUrl(trimmedUrl);
    // The patch names only this entry; the server merges it into its map.
    updateSettings({
      usageLimitSources: {
        [id]: {
          kind: "cliproxy",
          ...(label.trim() ? { label: label.trim() } : {}),
          url: trimmedUrl,
          managementKey: managementKey.trim(),
          enabled: true,
        },
      },
    });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>CLIProxyAPIハブを追加</DialogTitle>
          <DialogDescription>
            ハブ内の各アカウントの使用上限をエージェントの横に表示します。対象環境{" "}
            {environmentLabel}。キーはそのサーバー内に保存します。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-url">ハブのURL</Label>
              <Input
                id="usage-source-url"
                placeholder="https://hub.example.ts.net:8318"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-key">管理キー</Label>
              <Input
                id="usage-source-key"
                type="password"
                autoComplete="off"
                value={managementKey}
                onChange={(event) => setManagementKey(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">表示名（任意）</Label>
              <Input
                id="usage-source-label"
                placeholder="省略するとハブのホスト名を使います"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            キャンセル
          </Button>
          <Button onClick={save} disabled={!canSave}>
            ハブを追加
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
