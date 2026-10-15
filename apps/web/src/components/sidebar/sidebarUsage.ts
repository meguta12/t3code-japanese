import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";

const isSessionSlot = (window: ServerProviderUsageWindow) =>
  window.kind === "session" &&
  (window.windowDurationMins === undefined || window.windowDurationMins === 300);

/** The account-wide weekly allowance, or any weekly one that is not a per-model sub-limit. */
function weeklyCandidates(windows: readonly ServerProviderUsageWindow[]) {
  const account = windows.filter(
    (window) =>
      window.kind === "weekly" && (window.id === "seven_day" || window.id === "secondary"),
  );
  return account.length > 0
    ? account
    : windows.filter((window) => window.kind === "weekly" && !window.id.startsWith("seven_day_"));
}

/** A provider with several pools (Antigravity's Gemini and Claude groups) shows the tightest one. */
function tightest(candidates: readonly ServerProviderUsageWindow[]) {
  return candidates.reduce<ServerProviderUsageWindow | undefined>(
    (best, window) => (best === undefined || window.usedPercent > best.usedPercent ? window : best),
    undefined,
  );
}

/** True when the windows can fill a 5H or Week slot, even one that has since reset. */
export function hasSidebarQuotaWindows(windows: readonly ServerProviderUsageWindow[]): boolean {
  return windows.some(isSessionSlot) || weeklyCandidates(windows).length > 0;
}

export function sidebarQuotaWindows(windows: readonly ServerProviderUsageWindow[], now: number) {
  const session = tightest(windows.filter(isSessionSlot));
  const weekly = tightest(weeklyCandidates(windows));
  return (
    [
      ["5H", session],
      ["Week", weekly],
    ] as const
  ).map(([label, window]) => {
    const expired = window?.resetsAt !== undefined && Date.parse(window.resetsAt) <= now;
    const remaining = window && !expired ? remainingPercent(window) : null;
    return {
      label,
      remaining,
      resetsAt: window?.resetsAt,
      expired,
      color:
        remaining === null
          ? "var(--color-muted-foreground)"
          : remaining <= 10
            ? "var(--color-error)"
            : remaining <= 30
              ? "var(--color-warning)"
              : "var(--color-success)",
    };
  });
}

/** Subscription providers whose bars show even before the first read lands. */
const ALWAYS_LISTED_DRIVERS = new Set(["codex", "claudeAgent"]);

/**
 * Which accounts get a sidebar row: any provider reporting a 5H or Week window,
 * plus Codex and Claude while their first read is pending. An account that can
 * never report (API key) has nothing to draw. Cursor-style monthly pools have
 * no 5H or Week slot, so they stay on the Usage page.
 */
export function isSidebarQuotaRow(row: {
  readonly driver: string;
  readonly limits: ServerProviderUsageLimits | undefined;
}): boolean {
  if (row.limits !== undefined && hasSidebarQuotaWindows(row.limits.windows)) return true;
  return ALWAYS_LISTED_DRIVERS.has(row.driver) && row.limits?.unavailable?.reason !== "unsupported";
}
