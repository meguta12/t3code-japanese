import { formatDuration, formatResetsIn } from "@t3tools/shared/usageLimits";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { ja, jaTemplate } from "../../lib/ja";

/** Only accepts the fixed numeric output of the shared usage formatter. */
function localizeDuration(value: string): string {
  return value
    .replace(/(\d+)d/g, "$1日")
    .replace(/(\d+)h/g, "$1時間")
    .replace(/(\d+)m/g, "$1分");
}

export function formatUsageDuration(ms: number): string {
  return localizeDuration(formatDuration(ms));
}

export function formatUsageResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const value = formatResetsIn(window, now);
  if (value === null) return null;
  if (value === "resets now") return ja(value);
  return jaTemplate`Resets in ${localizeDuration(value.slice("resets in ".length))}`;
}
