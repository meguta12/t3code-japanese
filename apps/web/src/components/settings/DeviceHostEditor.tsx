import { ja, jaTemplate } from "../../lib/ja";
import { useState } from "react";
import * as Option from "effect/Option";
import type { SshDeviceHostConfig } from "@t3tools/contracts";
import { CheckIcon, MonitorIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { DeviceHostAvailability } from "../device/DeviceHostAvailability";
import { useHostConnectionChecks } from "./useHostConnectionChecks";
import {
  deviceHostConnectionKey,
  parseDeviceHostDraft,
  type DeviceHostCheckTarget,
} from "./deviceHostConnectionChecks";

export function DeviceHostEditor({
  host,
  isNew,
  targets,
  busy,
  onSave,
  onClose,
}: {
  host: SshDeviceHostConfig;
  isNew: boolean;
  targets: ReadonlyArray<DeviceHostCheckTarget>;
  busy: boolean;
  onSave: (host: SshDeviceHostConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(host);
  const { checks, testConnection } = useHostConnectionChecks(targets);
  const results = checks[deviceHostConnectionKey(draft)];
  const checking = Object.values(results ?? {}).some((check) => check.status === "pending");
  const input = parseDeviceHostDraft({ ...draft, label: draft.label.trim() || draft.target });
  const valid = Option.isSome(input);
  const failed = Object.values(results ?? {}).filter((check) => check.status === "failed").length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup
        showCloseButton={!busy}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (Option.isSome(input) && draft.label.trim() && !busy && !checking)
                onSave(input.value);
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{isNew ? "デバイスの接続先を追加" : "デバイスの接続先を編集"}</DialogTitle>
          <DialogDescription>
            {targets.length === 1
              ? jaTemplate`Connect from ${targets[0]?.label}.`
              : jaTemplate`Connect from ${targets.length} selected environments.`}{" "}
            同じパソコン上の接続先は除外します。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block space-y-1.5 text-sm">
            <span>名前</span>
            <Input
              autoFocus
              required
              value={draft.label}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              placeholder="Mac mini"
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>SSHの接続先</span>
            <Input
              required
              value={draft.target}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, target: event.target.value })}
              placeholder="user@host、またはSSHの別名"
            />
          </label>
          <details
            open={host.port !== undefined || host.identityFile !== undefined || undefined}
            className="text-sm"
          >
            <summary className="cursor-pointer text-muted-foreground">SSHの設定</summary>
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <label className="block space-y-1.5">
                <span>秘密鍵ファイル</span>
                <Input
                  value={draft.identityFile ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    const { identityFile: _, ...rest } = draft;
                    setDraft(
                      event.target.value ? { ...rest, identityFile: event.target.value } : rest,
                    );
                  }}
                  placeholder="SSH設定の既定値"
                />
              </label>
              <label className="block space-y-1.5">
                <span>ポート</span>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    const { port: _, ...rest } = draft;
                    setDraft(
                      event.target.value ? { ...rest, port: Number(event.target.value) } : rest,
                    );
                  }}
                  placeholder="既定"
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              省略できます。環境ごとに取得します。
            </p>
          </details>
          <div className="rounded-lg border border-border/60">
            <div className="flex items-center justify-between gap-3 px-3 py-2.5">
              <p role="status" className="text-xs text-muted-foreground">
                {checking
                  ? "環境を確認中…"
                  : results
                    ? failed
                      ? jaTemplate`${failed} of ${targets.length} failed`
                      : "接続の確認ができました"
                    : "保存前にアクセスを確認"}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || checking || !valid}
                onClick={() => {
                  if (Option.isSome(input)) void testConnection(input.value);
                }}
              >
                {checking ? <Spinner size="xs" /> : null} 接続をテスト
              </Button>
            </div>
            {results ? (
              <ul className="border-t border-border/60 divide-y divide-border/40">
                {ja(
                  targets.map((target) => {
                    const result = results[target.environmentId];
                    if (!result) return null;
                    return (
                      <li key={target.environmentId} className="px-3 py-2.5 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate font-medium">{ja(target.label)}</span>
                          <span
                            className={`flex shrink-0 items-center gap-1.5 ${result.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {result.status === "pending" ? (
                              <>
                                <Spinner size="xs" /> 確認中…
                              </>
                            ) : result.status === "local" ? (
                              <>
                                <MonitorIcon className="size-3" /> ローカルで利用可能です
                              </>
                            ) : result.status === "failed" ? (
                              <>
                                <XIcon className="size-3" /> 失敗
                              </>
                            ) : (
                              <>
                                <CheckIcon className="size-3" /> 接続済み
                              </>
                            )}
                          </span>
                        </div>
                        {result.status === "connected" ? (
                          <div className="mt-1.5">
                            <DeviceHostAvailability platforms={result.platforms} />
                          </div>
                        ) : null}
                        {result.status === "failed" ? (
                          <details className="mt-1.5 text-muted-foreground">
                            <summary className="cursor-pointer">エラーを表示</summary>
                            <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">
                              {ja(result.error)}
                            </p>
                          </details>
                        ) : null}
                      </li>
                    );
                  }),
                )}
              </ul>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" disabled={busy || checking || !valid || !draft.label.trim()}>
            {busy ? <Spinner size="xs" /> : null} 接続先を保存
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
