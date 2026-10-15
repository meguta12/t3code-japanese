import { useMemo } from "react";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { useEnvironment } from "../../state/environments";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { ProviderInstanceIcon, providerInstanceInitials } from "../chat/ProviderInstanceIcon";
import { getDisplayModelName, PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

type ProviderThread = Pick<EnvironmentThreadShell, "environmentId" | "session" | "modelSelection">;

export function ProviderThreadIcon({
  thread,
  providerEntry,
  className,
}: {
  thread: ProviderThread;
  providerEntry?: ProviderInstanceEntry | null;
  className?: string;
}) {
  const environment = useEnvironment(thread.environmentId);
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const entry = useMemo(
    () =>
      providerEntry ??
      deriveProviderInstanceEntries(environment?.serverConfig?.providers ?? []).find(
        (candidate) => candidate.instanceId === instanceId,
      ) ??
      null,
    [environment?.serverConfig?.providers, instanceId, providerEntry],
  );
  const recordedDriver = thread.session?.providerName;
  const driverKind = ProviderDriverKind.make(recordedDriver ?? entry?.driverKind ?? instanceId);
  const entryMatchesSession = recordedDriver == null || recordedDriver === entry?.driverKind;
  const name = (entryMatchesSession ? entry?.displayName : null) ?? recordedDriver ?? instanceId;
  const model = entry?.models.find((candidate) => candidate.slug === thread.modelSelection.model);
  const modelName = model ? getDisplayModelName(model) : thread.modelSelection.model;
  const label = `${name} · ${modelName}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className={cn("inline-flex shrink-0 items-center text-sidebar-muted-foreground", className)}
          />
        }
      >
        {PROVIDER_ICON_BY_PROVIDER[driverKind] ? (
          <ProviderInstanceIcon driverKind={driverKind} displayName={name} iconClassName="size-3.5" />
        ) : (
          <span className="inline-flex size-3.5 items-center justify-center text-4xs font-semibold">
            {providerInstanceInitials(name)}
          </span>
        )}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}
