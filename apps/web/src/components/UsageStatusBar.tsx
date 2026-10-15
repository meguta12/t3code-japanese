import { useAtomValue } from "@effect/atom-react";
import { Link, useParams } from "@tanstack/react-router";
import { ProviderDriverKind } from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useEffectEvent, useMemo } from "react";

import { useNowMinute } from "../hooks/useNowMinute";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import { environmentThreadDetails } from "../state/threads";
import { resolveThreadRouteRef } from "../threadRoutes";
import { environmentPresentations } from "../state/presentation";
import { useUsage } from "../state/usage";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  buildStatusBarChips,
  collectQuotaRows,
  decodeThreadKey,
  deriveThreadContextSummary,
  describeQuota,
  encodeThreadKey,
  formatContextLine,
  formatQuotaPercent,
  formatTodayTokens,
  formatTotalLine,
  isStatusBarProviderReady,
  STATUS_BAR_PROVIDERS,
  statusBarNeedsUsageScan,
  threadContextSummaryEqual,
  todayTokensByProvider,
  type StatusBarChip,
  type ThreadContextSummary,
} from "./UsageStatusBar.logic";

// A warm scan is cheap (the server caches per file size and mtime), so a slow
// poll keeps today's tokens fresh without opening the Usage page.
const TODAY_TOKENS_REFRESH_MS = 5 * 60_000;

const EMPTY_SUMMARY_ATOM = Atom.make<ThreadContextSummary | null>(null).pipe(
  Atom.withLabel("usage-status-bar:context:empty"),
);

// Selects only the figures the bar shows and returns the previous object while
// they are unchanged, so streaming activity never re-renders the bar.
const threadContextSummaryAtom = Atom.family((threadKey: string) => {
  const key = decodeThreadKey(threadKey);
  const threadRef = key === null ? null : resolveThreadRouteRef(key);
  let previous: ThreadContextSummary | null = null;
  return Atom.make((get) => {
    const detail = threadRef === null ? null : get(environmentThreadDetails.detailAtom(threadRef));
    const next = deriveThreadContextSummary(
      detail === null
        ? null
        : deriveLatestContextWindowSnapshot(
            detail.activities,
            detail.session
              ? {
                  provider: detail.session.providerName,
                  providerInstanceId: detail.session.providerInstanceId,
                }
              : undefined,
          ),
    );
    if (threadContextSummaryEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`usage-status-bar:context:${threadKey}`));
});

function ThreadContextStatus() {
  const threadKey = useParams({
    strict: false,
    select: (params) =>
      params.environmentId && params.threadId
        ? encodeThreadKey(params.environmentId, params.threadId)
        : null,
  });
  const summary = useAtomValue(
    threadKey === null ? EMPTY_SUMMARY_ATOM : threadContextSummaryAtom(threadKey),
  );
  const contextLine = formatContextLine(summary);
  const totalLine = formatTotalLine(summary);

  if (contextLine === null) {
    return <span className="shrink-0">—</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex min-w-0 items-center gap-3" />}>
        <span className="truncate tabular-nums">{contextLine}</span>
        {totalLine ? <span className="shrink-0 tabular-nums">{totalLine}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div>{contextLine}</div>
        {totalLine ? <div>{totalLine}（このセッションの処理量）</div> : null}
        <div>クリックで使用量の詳細</div>
      </TooltipPopup>
    </Tooltip>
  );
}

function ProviderChip({ chip }: { chip: StatusBarChip }) {
  const name =
    chip.kind === "quota" && chip.accountName ? `${chip.label} · ${chip.accountName}` : chip.label;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0 items-center gap-1" />}>
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make(chip.driver)}
          displayName={chip.label}
          iconClassName="size-3"
        />
        {chip.kind === "quota" ? (
          chip.quotas.map((quota) => (
            <span key={quota.label} className="flex items-center gap-0.5 tabular-nums">
              <span>{quota.label}</span>
              <span style={{ color: quota.color }}>{formatQuotaPercent(quota.remaining)}</span>
            </span>
          ))
        ) : (
          <span className="tabular-nums">{formatTodayTokens(chip.todayTokens)}</span>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div>{name}</div>
        {chip.kind === "quota" ? (
          <>
            {chip.quotas.map((quota) => (
              <div key={quota.label}>
                {quota.label} · {describeQuota(quota)}
                {quota.resetsAt
                  ? ` · リセット ${new Date(quota.resetsAt).toLocaleString("ja-JP")}`
                  : ""}
              </div>
            ))}
            {chip.checkedAt ? (
              <div>取得: {new Date(chip.checkedAt).toLocaleString("ja-JP")}</div>
            ) : null}
          </>
        ) : (
          <div>
            {chip.todayTokens === null
              ? "今日のトークン数を集計中"
              : `今日のトークン数 ${chip.todayTokens.toLocaleString("ja-JP")}`}
          </div>
        )}
        <div>クリックで使用量の詳細</div>
      </TooltipPopup>
    </Tooltip>
  );
}

function ChipRow({ chips }: { chips: readonly StatusBarChip[] }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-3">
      {chips.map((chip) => (
        <ProviderChip key={chip.key} chip={chip} />
      ))}
    </span>
  );
}

// Mounted only when a chip needs today's tokens, so the usage query is not
// subscribed (and not scanned at startup) otherwise.
function ChipsWithTodayTokens({
  buildChips,
}: {
  buildChips: (
    todayTokens: ReturnType<typeof todayTokensByProvider> | null,
  ) => readonly StatusBarChip[];
}) {
  // Re-evaluated each minute so the window rolls over at midnight; useUsage
  // keys its query on the window's contents, so an unchanged day is free.
  useNowMinute();
  const todayWindow = makeWindow(1);
  const { merged, isPending, refresh } = useUsage(todayWindow);
  const refreshToday = useEffectEvent(() => {
    if (document.visibilityState === "visible") void refresh().catch(() => undefined);
  });
  useEffect(() => {
    const id = window.setInterval(refreshToday, TODAY_TOKENS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);
  const todayTokens = useMemo(
    () => (isPending ? null : todayTokensByProvider(merged.daily, todayWindow.untilDay)),
    [isPending, merged.daily, todayWindow.untilDay],
  );
  const chips = useMemo(() => buildChips(todayTokens), [buildChips, todayTokens]);
  return <ChipRow chips={chips} />;
}

function ProviderChips() {
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const providers = useMemo(
    () =>
      [...presentations.values()].flatMap((presentation) =>
        (presentation.serverConfig?.providers ?? []).filter(isStatusBarProviderReady),
      ),
    [presentations],
  );
  const quotaRows = useMemo(() => collectQuotaRows(presentations), [presentations]);
  const buildChips = useMemo(
    () => (todayTokens: ReturnType<typeof todayTokensByProvider> | null) =>
      buildStatusBarChips({ providers, quotaRows, todayTokens, now }),
    [now, providers, quotaRows],
  );
  return statusBarNeedsUsageScan(providers, STATUS_BAR_PROVIDERS, quotaRows) ? (
    <ChipsWithTodayTokens buildChips={buildChips} />
  ) : (
    <ChipRow chips={buildChips(null)} />
  );
}

/**
 * Always-visible strip at the bottom of the window: the open thread's context
 * on the left, each connected provider's remaining quota or today's tokens on
 * the right. The whole strip opens the usage page. AppSidebarLayout reserves
 * its height through --app-status-bar-height.
 */
export function UsageStatusBar() {
  return (
    <Link
      to="/usage"
      data-usage-status-bar=""
      className="fixed inset-x-0 bottom-0 z-20 flex h-(--app-status-bar-height) select-none items-center gap-3 overflow-hidden border-t border-border bg-background px-3 text-2xs text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ThreadContextStatus />
      <ProviderChips />
    </Link>
  );
}
