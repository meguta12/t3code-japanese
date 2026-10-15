import { memo } from "react";
import type { ThreadId } from "@t3tools/contracts";

import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { type RunningModelStripView, type RunningModelTone } from "./composerRunningModel";

const DOT_CLASSES: Record<RunningModelTone, string> = {
  neutral: "bg-muted-foreground/60",
  info: "bg-info",
  warning: "bg-warning",
  error: "bg-destructive",
};

const SUBAGENT_STATUS = { pending: "待機中", running: "実行中", waiting: "要対応" } as const;

type ModelListProps = {
  readonly view: RunningModelStripView;
  readonly origin?:
    | {
        readonly parentThreadId: ThreadId;
        readonly parentModel: string;
        readonly parentTitle: string;
      }
    | null
    | undefined;
  readonly currentThreadId?: ThreadId | undefined;
  readonly isDelegatedChild?: boolean | undefined;
  readonly onOpenDelegatedThread?: ((threadId: ThreadId) => void) | undefined;
  readonly onOpenSubagents?: (() => void) | undefined;
};

/** Shared by the inline chip and the narrow composer's overflow menu. */
export const ComposerRunningModelMenuContent = memo(function ComposerRunningModelMenuContent({
  view,
  onOpenDelegatedThread,
  onOpenSubagents,
}: ModelListProps) {
  const { target, served } = view;
  return (
    <MenuGroup>
      <MenuGroupLabel>モデルと実行状態</MenuGroupLabel>
      <div role="status" className="px-2 py-1.5 text-xs">
        <div className="font-medium">
          {served?.modelName ?? target?.modelName ?? "モデル未選択"}
        </div>
        <div className="text-muted-foreground">
          {view.stateLabel} · {view.basisLabel}
        </div>
        {target ? (
          <div className="text-muted-foreground">
            {target.providerName} · {target.modelName}
            {target.effortLabel ? ` · ${target.effortLabel}` : ""}
          </div>
        ) : null}
        {target?.fastMode ? <div className="text-muted-foreground">高速モード</div> : null}
        {served ? (
          <div className="text-muted-foreground">
            実際: {served.modelName}
            {served.effortLabel ? ` · ${served.effortLabel}` : ""}
            {view.mismatch ? "（指定と異なります）" : ""}
          </div>
        ) : null}
      </div>
      {view.delegated.map((chip) => (
        <MenuItem
          key={chip.threadId}
          onClick={() => onOpenDelegatedThread?.(chip.threadId)}
          disabled={!onOpenDelegatedThread}
        >
          <span className="min-w-0 flex-1 truncate">委譲 · {chip.modelName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{chip.statusLabel} · 開く</span>
        </MenuItem>
      ))}
      {view.subagents.map((agent) => (
        <MenuItem key={agent.id} onClick={onOpenSubagents} disabled={!onOpenSubagents}>
          <span className="min-w-0 flex-1 truncate">
            サブ · {agent.model ?? "モデル未報告"} · {agent.title}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {SUBAGENT_STATUS[agent.status as keyof typeof SUBAGENT_STATUS] ?? "待機中"} · 開く
          </span>
        </MenuItem>
      ))}
    </MenuGroup>
  );
});

/** Static model chip beside access controls; its list opens on click. */
export const ComposerRunningModelStrip = memo(function ComposerRunningModelStrip({
  view,
  origin,
  currentThreadId,
  isDelegatedChild,
  size = "sm",
  hidden,
  onOpenDelegatedThread,
  onOpenSubagents,
}: ModelListProps & {
  readonly size?: ComposerControlSize;
  readonly hidden?: boolean | undefined;
}) {
  const [open, setOpen] = useComposerMenuState(hidden);
  const floatingLayerProps = useComposerMenuProps();
  const modelName = view.served?.modelName ?? view.target?.modelName ?? "モデル未選択";
  const summary = `${modelName} · ${view.stateLabel}${view.delegated.length ? ` · 委譲${view.delegated.length}` : ""}${view.subagents.length ? ` · サブ${view.subagents.length}` : ""}`;
  return (
    <div
      className="inline-flex min-w-48 max-w-md flex-1 items-center gap-1 overflow-x-auto"
      style={{ scrollbarWidth: "thin" }}
      data-delegation-models
    >
      {origin ? (
        <ComposerControl
          size={size}
          className="sticky left-0 z-10 border-border bg-background text-foreground"
          title={`親へ戻る: ${origin.parentTitle}`}
          aria-label={`親へ戻る: ${origin.parentTitle}`}
          onClick={() => onOpenDelegatedThread?.(origin.parentThreadId)}
        >
          <span className="text-3xs font-semibold">親</span>
          <span className="max-w-32 truncate">{origin.parentModel}</span>
          <span aria-hidden>→</span>
        </ComposerControl>
      ) : null}
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <ComposerControl
              size={size}
              className={
                origin || isDelegatedChild
                  ? "border-border bg-background text-foreground"
                  : "sticky left-0 z-10 border-border bg-background text-foreground"
              }
              data-chat-composer-running-model="true"
              data-state={view.state}
              aria-label={summary}
              title={summary}
            />
          }
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${DOT_CLASSES[view.tone]}`}
          />
          {origin || isDelegatedChild || view.delegated.length ? (
            <span className="text-3xs font-semibold">
              {origin || isDelegatedChild ? "子" : "親"}
            </span>
          ) : null}
          <span className="max-w-36 truncate">{modelName}</span>
          {view.target?.effortLabel ? (
            <span className="text-3xs text-muted-foreground">{view.target.effortLabel}</span>
          ) : null}
          {view.subagents.length ? (
            <span className="shrink-0">＋サブ{view.subagents.length}</span>
          ) : null}
        </MenuTrigger>
        <MenuPopup align="start" side="top" {...floatingLayerProps}>
          <ComposerRunningModelMenuContent
            view={view}
            onOpenDelegatedThread={onOpenDelegatedThread}
            onOpenSubagents={onOpenSubagents}
          />
        </MenuPopup>
      </Menu>
      {view.delegated
        .filter((chip) => chip.threadId !== currentThreadId)
        .map((chip) => (
          <ComposerControl
            key={chip.threadId}
            size={size}
            className="border-border bg-background text-foreground"
            onClick={() => onOpenDelegatedThread?.(chip.threadId)}
            disabled={!onOpenDelegatedThread}
            title={`${chip.title ?? "子セッション"}: ${chip.modelName} · ${chip.effortLabel ?? ""} · ${chip.statusLabel}`}
            aria-label={`${chip.title ?? "子"} ${chip.modelName} ${chip.statusLabel} を開く`}
          >
            <span aria-hidden>→</span>
            <span className="text-3xs font-semibold">子</span>
            <span className="max-w-32 truncate">{chip.modelName}</span>
            {chip.effortLabel ? (
              <span className="text-3xs text-muted-foreground">{chip.effortLabel}</span>
            ) : null}
            <span className="text-3xs text-muted-foreground">{chip.statusLabel}</span>
          </ComposerControl>
        ))}
    </div>
  );
});
