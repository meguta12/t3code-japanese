import { ja, jaTemplate } from "../../lib/ja";
import type { ReactNode } from "react";
import type { DeviceToolVersions as ToolVersions } from "@t3tools/contracts";
import { InlineButton } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";

export function DeviceToolVersions({
  tools,
  action,
  kind,
  owner,
  error,
}: {
  tools: ToolVersions | undefined;
  action?: ReactNode;
  kind?: keyof ToolVersions;
  owner?: string | undefined;
  error?: string | undefined;
}) {
  const selected = kind ? tools?.[kind] : undefined;
  const version =
    selected?.runningVersion ??
    (selected?.installedVersions.includes(selected.requiredVersion)
      ? selected.requiredVersion
      : selected?.installedVersions
          .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .at(-1));
  const label = kind === "hub" ? "Device hub" : "Agent device";
  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          kind
            ? jaTemplate`${ja(label)}: ${version ? jaTemplate`version ${version}` : selected ? ja("not installed") : ja("version unknown")}. Show details`
            : undefined
        }
        render={<InlineButton tone="muted" />}
      >
        {kind
          ? version
            ? `v${version}`
            : selected
              ? "未インストール"
              : ja("Version unknown")
          : error
            ? ja("Versions unavailable")
            : ja("Versions")}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md">
        <PopoverTitle>{kind ? ja(label) : "デバイスのツール"}</PopoverTitle>
        {tools ? (
          <div className="mt-4 divide-y divide-border/50">
            {(
              [
                ["Device hub", tools.hub],
                ["Agent device", tools.agent],
              ] as const
            )
              .filter(([name]) => !kind || name === label)
              .map(([name, tool]) => (
                <div key={name} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  {!kind ? <p className="text-xs font-medium">{ja(name)}</p> : null}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">実行中</dt>
                    <dd className="text-right font-mono">
                      {tool.runningVersion ?? ja("Not running")}
                    </dd>
                    <dt className="text-muted-foreground">必須</dt>
                    <dd className="text-right font-mono">{tool.requiredVersion}</dd>
                    <dt className="text-muted-foreground">インストール済み</dt>
                    <dd className="text-right font-mono break-words">
                      {tool.installedVersions.join(", ") || ja("None")}
                    </dd>
                  </dl>
                </div>
              ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">バージョンはまだ確認されていません。</p>
        )}
        <p className="mt-4 border-t border-border/50 pt-3 text-xs text-muted-foreground">
          {owner ? jaTemplate`Managed by ${owner}. ` : ""}
          必要に応じて、接続先でツールを自動更新します。
        </p>
        {error ? (
          <p role="status" className="mt-2 text-xs text-destructive">
            {ja(error)}
          </p>
        ) : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </PopoverPopup>
    </Popover>
  );
}
