import {
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageProviderKind,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  providersWithLimits,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

import type { ContextWindowSnapshot } from "../lib/contextWindow";
import { deriveSessionTokenUsage, formatSessionTokens } from "../lib/sessionTokenUsage";
import { hasSidebarQuotaWindows, sidebarQuotaWindows } from "./sidebar/sidebarUsage";

/**
 * Providers the bottom status bar can show, in display order. Adding a provider
 * (for example Command Code) is one entry here:
 * - `driver` is the ServerProvider driver slug.
 * - `usageKind` is its key in the usage scanner (null when the scanner has none).
 * - `quota` shows 5H / Week remaining instead of today's tokens.
 * - `quotaWhenAvailable` does the same once the provider reports a 5H or Week
 *   window, and keeps today's tokens until then (signed out, CLI too old).
 */
export interface StatusBarProviderConfig {
  readonly driver: string;
  readonly usageKind: UsageProviderKind | null;
  readonly label: string;
  readonly quota: boolean;
  readonly quotaWhenAvailable?: boolean;
}

export const STATUS_BAR_PROVIDERS: readonly StatusBarProviderConfig[] = [
  { driver: "codex", usageKind: "codex", label: "Codex", quota: true },
  { driver: "claudeAgent", usageKind: "claude", label: "Claude Code", quota: true },
  { driver: "opencode", usageKind: "opencode", label: "OpenCode", quota: false },
  {
    driver: "antigravity",
    usageKind: "antigravity",
    label: "Antigravity",
    quota: false,
    quotaWhenAvailable: true,
  },
  {
    driver: "commandcode",
    usageKind: "commandcode",
    label: "Command Code",
    quota: false,
    quotaWhenAvailable: true,
  },
];

// --- Active thread context ---------------------------------------------------

export interface ThreadContextSummary {
  readonly contextTokens: number;
  readonly maxTokens: number | null;
  readonly usedPercentage: number | null;
  readonly totalTokens: number | null;
  readonly lastTokens: number | null;
}

export function deriveThreadContextSummary(
  snapshot: ContextWindowSnapshot | null,
): ThreadContextSummary | null {
  const tokens = deriveSessionTokenUsage(snapshot);
  if (snapshot === null || tokens.contextTokens === null) return null;
  return {
    contextTokens: tokens.contextTokens,
    maxTokens: snapshot.maxTokens ?? null,
    usedPercentage: snapshot.usedPercentage,
    totalTokens: tokens.totalTokens,
    lastTokens: tokens.lastTokens,
  };
}

/** Lets the derived atom return the previous object so unchanged data never re-renders. */
export function threadContextSummaryEqual(
  a: ThreadContextSummary | null,
  b: ThreadContextSummary | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.contextTokens === b.contextTokens &&
    a.maxTokens === b.maxTokens &&
    a.usedPercentage === b.usedPercentage &&
    a.totalTokens === b.totalTokens &&
    a.lastTokens === b.lastTokens
  );
}

export function encodeThreadKey(environmentId: string, threadId: string): string {
  return JSON.stringify([environmentId, threadId]);
}

export function decodeThreadKey(key: string): { environmentId: string; threadId: string } | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { environmentId: parsed[0], threadId: parsed[1] };
    }
  } catch {
    // Fall through: a malformed key means no active thread.
  }
  return null;
}

/** "コンテキスト 12.3万 / 100万 (12%)", or null when the thread has no context data. */
export function formatContextLine(summary: ThreadContextSummary | null): string | null {
  if (summary === null) return null;
  const used = formatSessionTokens(summary.contextTokens, true);
  const max = summary.maxTokens === null ? null : formatSessionTokens(summary.maxTokens, true);
  const percent = summary.usedPercentage === null ? null : `${Math.round(summary.usedPercentage)}%`;
  return `コンテキスト ${used}${max === null ? "" : ` / ${max}`}${percent === null ? "" : ` (${percent})`}`;
}

export function formatTotalLine(summary: ThreadContextSummary | null): string | null {
  if (summary === null || summary.totalTokens === null) return null;
  return `累計 ${formatSessionTokens(summary.totalTokens, true)}`;
}

// --- Provider chips ----------------------------------------------------------

/** One subscription account's limits, whether or not it has usable windows yet. */
export interface QuotaRow {
  readonly key: string;
  readonly driver: string;
  readonly displayName: string | null;
  readonly limits: ServerProviderUsageLimits | undefined;
}

/** Same account selection as the sidebar bars: reported accounts first, then providers still without windows. */
export function collectQuotaRows(presentations: LimitPresentations): readonly QuotaRow[] {
  const accounts = collectLimitAccounts(presentations);
  const rows: QuotaRow[] = accounts.map((account) => ({
    key: account.key,
    driver: account.driver,
    displayName: account.displayName,
    limits: account.limits,
  }));
  for (const [environmentId, presentation] of presentations) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const reported = accounts.some(
        (account) =>
          account.driver === provider.driver &&
          (provider.auth.email
            ? account.email === provider.auth.email
            : account.key === `${environmentId}:${provider.instanceId}`),
      );
      if (!reported) {
        rows.push({
          key: `${environmentId}:${provider.instanceId}`,
          driver: provider.driver,
          displayName: provider.displayName ?? null,
          limits: provider.usageLimits,
        });
      }
    }
  }
  return rows;
}

/** Accounts of one driver that report a 5H or Week window right now. */
function rowsWithQuota(rows: readonly QuotaRow[], driver: string): readonly QuotaRow[] {
  return rows.filter(
    (row) => row.driver === driver && row.limits && hasSidebarQuotaWindows(row.limits.windows),
  );
}

export function isStatusBarProviderReady(provider: ServerProvider): boolean {
  return provider.enabled && provider.installed && isProviderAvailable(provider);
}

export type StatusBarQuota = ReturnType<typeof sidebarQuotaWindows>[number];

export type StatusBarChip =
  | {
      readonly kind: "quota";
      readonly key: string;
      readonly driver: string;
      readonly label: string;
      /** Distinguishes several accounts of one provider; null for a single account. */
      readonly accountName: string | null;
      readonly quotas: readonly StatusBarQuota[];
      readonly checkedAt: string | undefined;
    }
  | {
      readonly kind: "tokens";
      readonly key: string;
      readonly driver: string;
      readonly label: string;
      /** null while the usage scan has not answered yet. */
      readonly todayTokens: number | null;
    };

/**
 * `todayTokens` is null until the usage summary has answered; a provider with no
 * bucket today then reads 0 rather than unknown.
 */
export function buildStatusBarChips(input: {
  readonly providers: readonly ServerProvider[];
  readonly quotaRows: readonly QuotaRow[];
  readonly todayTokens: ReadonlyMap<UsageProviderKind, number> | null;
  readonly now: number;
  readonly config?: readonly StatusBarProviderConfig[];
}): readonly StatusBarChip[] {
  const chips: StatusBarChip[] = [];
  for (const config of input.config ?? STATUS_BAR_PROVIDERS) {
    if (
      !input.providers.some(
        (provider) => provider.driver === config.driver && isStatusBarProviderReady(provider),
      )
    ) {
      continue;
    }
    const reporting = rowsWithQuota(input.quotaRows, config.driver);
    if (config.quota || (config.quotaWhenAvailable && reporting.length > 0)) {
      const rows = config.quota
        ? input.quotaRows.filter((row) => row.driver === config.driver)
        : reporting;
      const accounts = rows.length > 0 ? rows : [null];
      accounts.forEach((row, index) => {
        chips.push({
          kind: "quota",
          key: row?.key ?? config.driver,
          driver: config.driver,
          label: config.label,
          accountName: accounts.length > 1 ? (row?.displayName ?? `アカウント${index + 1}`) : null,
          quotas: sidebarQuotaWindows(row?.limits?.windows ?? [], input.now),
          checkedAt: row?.limits?.checkedAt,
        });
      });
      continue;
    }
    chips.push({
      kind: "tokens",
      key: config.driver,
      driver: config.driver,
      label: config.label,
      todayTokens:
        input.todayTokens === null || config.usageKind === null
          ? null
          : (input.todayTokens.get(config.usageKind) ?? 0),
    });
  }
  return chips;
}

/** Providers that need the usage scan to fill their chip. */
export function statusBarNeedsUsageScan(
  providers: readonly ServerProvider[],
  config: readonly StatusBarProviderConfig[] = STATUS_BAR_PROVIDERS,
  quotaRows: readonly QuotaRow[] = [],
): boolean {
  return config.some(
    (entry) =>
      !entry.quota &&
      entry.usageKind !== null &&
      !(entry.quotaWhenAvailable && rowsWithQuota(quotaRows, entry.driver).length > 0) &&
      providers.some(
        (provider) => provider.driver === entry.driver && isStatusBarProviderReady(provider),
      ),
  );
}

/** Today's total tokens per provider, from the merged daily rows. */
export function todayTokensByProvider(
  daily: readonly DailyTotals[],
  day: string,
): ReadonlyMap<UsageProviderKind, number> {
  const totals = new Map<UsageProviderKind, number>();
  for (const row of daily) {
    if (row.day !== day) continue;
    for (const [provider, value] of row.byProvider) {
      totals.set(provider, (totals.get(provider) ?? 0) + value.totalTokens);
    }
  }
  return totals;
}

export function formatQuotaPercent(remaining: number | null): string {
  return remaining === null ? "—" : `${remaining}%`;
}

export function describeQuota(quota: StatusBarQuota): string {
  if (quota.remaining !== null) return `残り ${quota.remaining}%`;
  return quota.expired ? "更新待ち" : "残量未取得";
}

export function formatTodayTokens(todayTokens: number | null): string {
  return todayTokens === null ? "今日 —" : `今日 ${formatSessionTokens(todayTokens, true)}tok`;
}
