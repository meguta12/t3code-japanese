import { Children, type ReactNode } from "react";
import { create } from "zustand";
import { type DelegationRole } from "../../lib/delegationGroups";
import { useDelegationFamilyColor } from "../../state/delegation";

export function DelegationRoleBadge({ role }: { readonly role: DelegationRole | undefined }) {
  if (!role) return null;
  return (
    <span
      className="mr-1 inline-flex rounded-sm border border-current/25 px-1 py-0.5 align-middle text-3xs leading-none text-muted-foreground"
      data-delegation-role={role}
    >
      {role === "parent" ? "親" : "子"}
    </span>
  );
}

export const useDelegationTreeStore = create<{
  collapsedFamilies: ReadonlySet<string>;
  toggle: (key: string) => void;
}>((set) => ({
  collapsedFamilies: new Set(),
  toggle: (key) =>
    set((state) => {
      const collapsedFamilies = new Set(state.collapsedFamilies);
      if (collapsedFamilies.has(key)) collapsedFamilies.delete(key);
      else collapsedFamilies.add(key);
      return { collapsedFamilies };
    }),
}));

/** One outline surrounds the complete family; rows keep their normal selection look. */
export function DelegationThreadGroup({
  familyKey,
  asListItem = false,
  hasParent,
  children,
}: {
  readonly familyKey: string;
  readonly asListItem?: boolean;
  readonly hasParent: boolean;
  readonly children: ReactNode;
}) {
  const color = useDelegationFamilyColor(familyKey);
  const collapsed = useDelegationTreeStore((state) => state.collapsedFamilies.has(familyKey));
  const toggle = useDelegationTreeStore((state) => state.toggle);
  const rows = Children.toArray(children);
  const parentRows = hasParent ? rows.slice(0, 1) : [];
  const childRows = hasParent ? rows.slice(1) : rows;
  const content = (
    <>
      <button
        type="button"
        data-thread-selection-safe
        aria-expanded={!collapsed}
        aria-label={`子セッション${childRows.length}件を${collapsed ? "展開" : "折りたたむ"}`}
        className="flex w-full items-center gap-1 rounded px-2 pt-1.5 pb-1 text-left text-3xs font-medium hover:bg-sidebar-row-hover focus-visible:outline-2"
        style={{ color }}
        onClick={() => toggle(familyKey)}
      >
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        親子セッション <span className="ml-auto">子 {childRows.length}</span>
      </button>
      {parentRows.length > 0 ? <ul className="list-none">{parentRows}</ul> : null}
      {!collapsed ? (
        <ul
          data-delegation-children
          className="list-none space-y-0.5 [&>li]:[content-visibility:visible] [&>li]:relative [&>li]:ml-[1em] [&>li]:before:pointer-events-none [&>li]:before:absolute [&>li]:before:top-0 [&>li]:before:bottom-[-2px] [&>li]:before:-left-[0.5em] [&>li]:before:border-l [&>li]:before:border-current/40 [&>li]:last:before:bottom-1/2 [&>li]:after:pointer-events-none [&>li]:after:absolute [&>li]:after:top-1/2 [&>li]:after:-left-[0.5em] [&>li]:after:w-[0.5em] [&>li]:after:border-t [&>li]:after:border-current/40"
          style={{ color }}
        >
          {childRows}
        </ul>
      ) : null}
    </>
  );
  const props = {
    className: "my-1 min-w-0 rounded-lg border-2 px-0.5 pb-0.5",
    style: { borderColor: color },
    "data-delegation-family": familyKey,
  };
  return asListItem ? <li {...props}>{content}</li> : <div {...props}>{content}</div>;
}
