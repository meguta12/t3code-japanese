import { ja, jaTemplate } from "../../lib/ja";
import { translateSnapShotShortcutMessage } from "./SnapShotSettings.logic";
import {
  isModifierPairShortcut,
  type DesktopCaptureConfigApplied,
  type DesktopCaptureConfigPreview,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";
import { useMemo, useState } from "react";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { useTheme } from "../../hooks/useTheme";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { shortcutToKeybindingInput } from "./KeybindingsSettings.logic";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

const DEFAULT_SHORTCUT = parseKeybindingShortcut("Ctrl+Shift+2")!;

/** Wizard-owned config review; config contents never leave the desktop bridge. */
export function CaptureShortcutConfig({
  state,
  disabled = false,
  onBusyChange,
  onSaved,
  onComplete,
}: {
  state: DesktopSnapShotState;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onSaved?: () => Promise<unknown>;
  onComplete?: () => Promise<void>;
}) {
  const bridge = getDesktopSnapShotBridge();
  const { resolvedTheme } = useTheme();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [preview, setPreview] = useState<DesktopCaptureConfigPreview | null>(null);
  const [result, setResult] = useState<DesktopCaptureConfigApplied | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [working, setWorking] = useState<"reading" | "writing" | null>(null);
  const [keys, setKeys] = useState<string | null>(null);
  const [customFile, setCustomFile] = useState(false);
  const busy = disabled || working !== null;
  const supported = Boolean(bridge?.previewSnapShotConfig && bridge.applySnapShotConfig);
  const changed = preview !== null && preview.before !== preview.after;
  const niri = state.linuxBackend === "niri";
  const desktop = niri ? "Niri" : "Hyprland";
  const shortcutKeys = (keys ?? preview?.shortcut)?.trim();
  const recorder = useSnapShotShortcutRecorder({
    shortcut: shortcutKeys
      ? (parseKeybindingShortcut(shortcutKeys.replace(/super/gi, "meta")) ?? DEFAULT_SHORTCUT)
      : DEFAULT_SHORTCUT,
    disabled: busy,
    allowModifierPairs: false,
    onStart: () => setError(null),
    onError: (message) => setError({ message }),
    onRecord: (shortcut) => {
      if (isModifierPairShortcut(shortcut)) return;
      setKeys(
        shortcutToKeybindingInput({
          ...shortcut,
          ctrlKey: shortcut.ctrlKey || shortcut.modKey,
          modKey: false,
        }),
      );
      setPreview(null);
      setError(null);
    },
  });
  const actionBusy = busy || recorder.recording;
  const diff = useMemo(
    () =>
      preview && changed
        ? parseDiffFromFile(
            { name: preview.path, contents: preview.before },
            { name: preview.path, contents: preview.after },
          )
        : null,
    [preview, changed],
  );
  const begin = (phase: "reading" | "writing") => {
    setWorking(phase);
    onBusyChange?.(true);
    setError(null);
  };
  const end = () => {
    setWorking(null);
    onBusyChange?.(false);
  };
  const read = async (chooseFile = customFile, operation: "install" | "remove" = "install") => {
    if (actionBusy || !bridge?.previewSnapShotConfig) return;
    begin("reading");
    setPreview(null);
    setResult(null);
    setCustomFile(chooseFile);
    try {
      setPreview(
        await bridge.previewSnapShotConfig({
          operation,
          chooseFile,
          ...(keys?.trim() ? { shortcut: keys.trim() } : {}),
        }),
      );
    } catch (cause) {
      setError({
        message: "Couldn't prepare the changes. Check Advanced for help.",
        ...(cause instanceof Error ? { detail: cause.message } : {}),
      });
    } finally {
      end();
    }
  };
  const apply = async () => {
    if (actionBusy || !preview || !bridge?.applySnapShotConfig) return;
    begin("writing");
    try {
      const applied = await bridge.applySnapShotConfig(preview.id);
      setResult(applied);
      await onSaved?.();
      if (!applied.warning && preview.operation === "install" && onComplete) {
        toastManager.add({
          type: "success",
          title: "Shortcut saved",
          description: `Use ${preview.shortcut} from another app.`,
        });
        await onComplete();
      }
    } catch (cause) {
      setError({
        message: "Couldn't save your shortcut. Review the changes and try again.",
        ...(cause instanceof Error ? { detail: cause.message } : {}),
      });
      setPreview(null);
    } finally {
      end();
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {!result ? (
        <div className="flex items-center justify-between gap-3">
          <span>ショートカット</span>
          {ja(recorder.input)}
        </div>
      ) : null}
      {recorder.recording ? (
        <p role="status" className="text-xs text-muted-foreground">
          ショートカットを押してください。Escでキャンセルします。
        </p>
      ) : null}
      {result ? (
        <p role="status">
          {result.warning
            ? "保存しましたが、ショートカットの確認が必要です。詳細設定を確認してください。"
            : preview?.operation === "remove"
              ? "ショートカットを削除しました。"
              : jaTemplate`Use ${preview?.shortcut} from another app to capture a window.`}
        </p>
      ) : preview ? (
        <>
          <p className="text-muted-foreground">
            {changed
              ? preview.operation === "remove"
                ? "下の変更を確認して、ショートカットを削除してください。"
                : "下の変更を確認して、ショートカットを保存してください。"
              : preview.operation === "remove"
                ? "削除するキャプチャ用ショートカットはありません。"
                : "このショートカットは設定済みです。"}
          </p>
          {diff ? (
            <div
              className="max-h-80 overflow-auto rounded-lg border text-xs"
              aria-label="ショートカットの変更"
            >
              <FileDiff
                fileDiff={diff}
                options={{
                  diffStyle: "unified",
                  theme: resolveDiffThemeName(resolvedTheme),
                  overflow: "wrap",
                }}
              />
            </div>
          ) : null}
          {changed ? (
            <p className="text-xs text-muted-foreground">
              ここに表示した変更だけを保存します。バックアップも残します。
            </p>
          ) : null}
          <div className="flex gap-2">
            {changed || preview.operation === "install" ? (
              <Button
                disabled={
                  actionBusy ||
                  (preview.operation === "install" && state.shortcutActionRegistered === false)
                }
                aria-busy={working === "writing"}
                onClick={() => void apply()}
              >
                {working === "writing"
                  ? "保存中…"
                  : changed
                    ? preview.operation === "install"
                      ? "ショートカットを保存"
                      : "ショートカットを削除"
                    : "完了"}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={actionBusy} onClick={() => setPreview(null)}>
              キャンセル
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            デスクトップの設定をT3
            Codeに読み取らせます。保存する前に、変更内容をここで確認できます。
          </p>
          <Button
            disabled={actionBusy || !supported}
            aria-busy={working === "reading"}
            onClick={() => void read()}
          >
            {working === "reading" ? "変更を準備中…" : "変更を確認"}
          </Button>
          {!supported ? (
            <p className="text-xs text-muted-foreground">
              ショートカットの設定を完了するには、T3 Codeを更新してください。
            </p>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-destructive">
          {ja(error.message)}
        </p>
      ) : null}
      {state.shortcutActionRegistered === false && state.shortcutMessage ? (
        <p role="status" className="text-muted-foreground">
          {state.shortcutPending
            ? "デスクトップに接続中…"
            : "ショートカットの接続を完了するには、T3 Codeを再起動してください。"}
        </p>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">詳細設定</summary>
        <div className="mt-3 space-y-3">
          {error?.detail || result?.warning ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground">問題の解決</p>
              <p className="break-words">{ja(error?.detail ?? result?.warning)}</p>
            </div>
          ) : null}
          <div className="space-y-1">
            <p className="font-medium text-foreground">設定ファイル</p>
            <p className="break-all font-mono">
              {ja(
                preview?.path ??
                  state.shortcutConfigPath ??
                  (niri ? "~/.config/niri/config.kdl" : "~/.config/hypr/hyprland.conf"),
              )}
            </p>
            {niri ? <p>このファイルが読み込む別の設定ファイルも、T3 Codeで読み取ります。</p> : null}
            {preview && preview.resolvedPath !== preview.path ? (
              <p className="break-all">参照先 {preview.resolvedPath}。リンクはそのまま残します。</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy || !supported}
              onClick={() => void read(true)}
            >
              別のファイルを選択…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionBusy || !supported}
              onClick={() => void read(customFile, "remove")}
            >
              ショートカットを削除…
            </Button>
            {result ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy || !supported}
                onClick={() => void read()}
              >
                変更を確認
              </Button>
            ) : null}
          </div>
          <p>
            デスクトップのショートカット設定ファイルを使います。{" "}
            {niri
              ? "--configやNIRI_CONFIGを指定している場合、保存場所が異なることがあります。"
              : "Omarchyでは、既定の設定ではなく自分のキー設定ファイルを使ってください。"}
          </p>
          {result?.backupPath ? (
            <p className="break-all">バックアップ： {ja(result.backupPath)}</p>
          ) : null}
          <p className="font-medium text-foreground">手動設定</p>
          <p>
            {niri
              ? "Niriの設定のbinds { … }内に貼り付け、保存してください。"
              : "Hyprlandの設定に追加して保存してください。"}{" "}
            必要に応じてキーを変更してください。
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-3">
            {ja(state.shortcutBinding)}
          </pre>
          <Button
            size="sm"
            variant="outline"
            disabled={actionBusy || !state.shortcutBinding}
            onClick={() => {
              if (state.shortcutBinding) copyToClipboard(state.shortcutBinding);
            }}
          >
            {isCopied ? "コピーしました" : "ショートカットをコピー"}
          </Button>
          <p>
            停止するにはT3
            Codeのキャプチャをオフにします。キーを解除する場合はショートカットを削除してください。対象{" "}
            {ja(desktop)} から削除してください。
          </p>
          {state.shortcutActionRegistered === false ? (
            <p role="status">{translateSnapShotShortcutMessage(state.shortcutMessage)}</p>
          ) : null}
          {onComplete ? (
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy || state.shortcutActionRegistered === false}
              onClick={() => void onComplete()}
            >
              ショートカットを追加しました
            </Button>
          ) : null}
        </div>
      </details>
    </div>
  );
}
