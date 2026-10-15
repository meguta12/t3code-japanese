import { ja } from "../../lib/ja";
import { CircleCheckIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "../ui/button";

export interface PermissionItem {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  granted: boolean;
  onAllow: () => void;
}

export function PermissionChecklist({
  permissions,
  busy = false,
}: {
  permissions: readonly PermissionItem[];
  busy?: boolean;
}) {
  return (
    <div className="space-y-2">
      {permissions.map((permission) => (
        <div key={permission.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
          {permission.icon}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{ja(permission.title)}</p>
            <p className="text-xs text-muted-foreground">{ja(permission.description)}</p>
          </div>
          {permission.granted ? (
            <span role="status" className="flex items-center gap-1 text-xs text-success">
              <CircleCheckIcon className="size-4" aria-hidden="true" />
              許可済み
            </span>
          ) : (
            <Button size="xs" variant="outline" disabled={busy} onClick={permission.onAllow}>
              許可
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function PermissionContinueButton({
  ready,
  busy = false,
  children = "Continue",
  ...props
}: Omit<ComponentProps<typeof Button>, "disabled"> & { ready: boolean; busy?: boolean }) {
  return (
    <Button {...props} disabled={!ready || busy}>
      {children}
    </Button>
  );
}
