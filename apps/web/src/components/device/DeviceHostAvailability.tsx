import { ja } from "~/lib/ja";
import type { DevicePlatformAvailability } from "@t3tools/contracts";
import { Check, Minus } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

export function DeviceHostAvailability({
  platforms,
}: {
  platforms: ReadonlyArray<DevicePlatformAvailability>;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {platforms.map((platform) => (
        <Tooltip key={platform.platform}>
          <TooltipTrigger render={<span tabIndex={0} className="inline-flex items-center gap-1" />}>
            {platform.available ? <Check className="size-3" /> : <Minus className="size-3" />}
            {platform.platform === "ios" ? "iOS" : "Android"}{" "}
            {ja(platform.available ? "available" : "unavailable")}
          </TooltipTrigger>
          <TooltipPopup>
            {ja(
              platform.reason ??
                (platform.platform === "ios" ? "iOS available" : "Android available"),
            )}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
