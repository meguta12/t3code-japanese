import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { collectLimitAccounts, providersWithLimits } from "@t3tools/shared/usageLimits";
import { useNowMinute } from "../../hooks/useNowMinute";
import { environmentPresentations } from "../../state/presentation";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarQuotaRow, sidebarQuotaWindows } from "./sidebarUsage";

export function SidebarUsageBars() {
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const accounts = collectLimitAccounts(presentations);
  const unavailable = [...presentations].flatMap(([environmentId, presentation]) =>
    providersWithLimits(presentation.serverConfig?.providers ?? []).flatMap((provider) =>
      accounts.some(
        (account) =>
          account.driver === provider.driver &&
          (provider.auth.email
            ? account.email === provider.auth.email
            : account.key === `${environmentId}:${provider.instanceId}`),
      )
        ? []
        : [
            {
              key: `${environmentId}:${provider.instanceId}`,
              driver: provider.driver,
              displayName: provider.displayName,
              limits: provider.usageLimits,
            },
          ],
    ),
  );
  const rows = [...accounts, ...unavailable].filter(isSidebarQuotaRow);
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-sidebar-border px-2 py-2">
      {rows.map((account) => {
        const driver = getDriverOption(account.driver)?.label ?? account.driver;
        const label =
          account.displayName && account.displayName.toLowerCase() !== driver.toLowerCase()
            ? `${driver} · ${account.displayName}`
            : driver;
        const sameDriver = rows.filter((row) => row.driver === account.driver);
        const name = sameDriver.length > 1 ? `${label} ${sameDriver.indexOf(account) + 1}` : label;
        return (
          <div key={account.key} className="flex min-w-0 items-center gap-2">
            <span className="w-20 shrink-0 truncate text-2xs text-muted-foreground">{name}</span>
            {sidebarQuotaWindows(account.limits?.windows ?? [], now).map((quota) => (
              <Tooltip key={quota.label}>
                <TooltipTrigger
                  render={
                    <Link
                      to="/usage"
                      aria-label={`${name} ${quota.label} 残り${quota.remaining === null ? "未取得" : `${quota.remaining}%`}`}
                      className="flex min-w-0 flex-1 items-center gap-1 rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  <span className="shrink-0 text-3xs text-muted-foreground">{quota.label}</span>
                  <span
                    className="h-1.5 min-w-3 flex-1 overflow-hidden rounded-full bg-muted"
                    style={
                      quota.remaining === 0
                        ? { boxShadow: `inset 0 0 0 1px ${quota.color}` }
                        : undefined
                    }
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${quota.remaining ?? 0}%`,
                        backgroundColor: quota.color,
                      }}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {name} · {quota.label} ·{" "}
                  {quota.remaining === null
                    ? quota.expired
                      ? "更新待ち"
                      : "残量未取得"
                    : `残り ${quota.remaining}%`}
                  {quota.resetsAt ? (
                    <div>リセット: {new Date(quota.resetsAt).toLocaleString("ja-JP")}</div>
                  ) : null}
                  {account.limits ? (
                    <div>取得: {new Date(account.limits.checkedAt).toLocaleString("ja-JP")}</div>
                  ) : null}
                  <div>クリックで使用量の詳細</div>
                </TooltipPopup>
              </Tooltip>
            ))}
          </div>
        );
      })}
    </div>
  );
}
