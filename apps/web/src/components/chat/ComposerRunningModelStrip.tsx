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
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            data-chat-composer-running-model="true"
            data-state={view.state}
            aria-label={summary}
            title={summary}
          />
        }
      >
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${DOT_CLASSES[view.tone]}`} />
        <span className="max-w-36 truncate">{modelName}</span>
        {view.delegated.length ? (
          <span className="shrink-0">＋委譲{view.delegated.length}</span>
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
  );
});
