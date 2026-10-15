import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildLinkedThreadActionItems,
  type CommandPaletteActionItem,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";

// Keep collection iteration while removing the DOM-backed autocomplete shell.
vi.mock("./ui/command", async () => {
  const { createContext, use } = await import("react");
  const Items = createContext<readonly CommandPaletteActionItem[]>([]);
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    CommandList: Container,
    CommandGroupLabel: Container,
    CommandShortcut: Container,
    CommandGroup: ({
      items,
      children,
    }: {
      items: readonly CommandPaletteActionItem[];
      children?: ReactNode;
    }) => <Items value={items}>{children}</Items>,
    CommandCollection: ({
      children,
    }: {
      children: (item: CommandPaletteActionItem) => ReactNode;
    }) => use(Items).map(children),
    CommandItem: ({ children, onClick }: { children?: ReactNode; onClick: () => void }) => (
      <button onClick={onClick}>{children}</button>
    ),
  };
});

describe("command palette authored labels", () => {
  it.each([false, true])(
    "preserves a thread title when disabled=%s and opens the selected thread",
    async (disabled) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const runThread = vi.fn(async () => {});
      const environmentId = EnvironmentId.make("environment-1");
      const id = ThreadId.make("thread-1");
      const items = buildLinkedThreadActionItems({
        environmentId,
        query: "Done",
        icon: null,
        runThread,
        threads: [{ id, projectId: ProjectId.make("project-1"), title: "Done", archivedAt: null }],
      }).map((item) => ({ ...item, disabled }));
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(async () => {
          renderer = create(
            <CommandPaletteResults
              groups={[{ value: "threads", label: "Threads", items }]}
              isActionsOnly={false}
              keybindings={[]}
              onExecuteItem={(item) => {
                if (item.kind === "action") void item.run();
              }}
            />,
          );
        });
        expect(
          renderer!.root.findAllByType("span").some((node) => node.children.join("") === "Done"),
        ).toBe(true);
        expect(
          renderer!.root.findAllByType("span").some((node) => node.children.join("") === "完了"),
        ).toBe(false);
        if (!disabled) {
          await act(async () => renderer!.root.findByType("button").props.onClick());
          expect(runThread).toHaveBeenCalledExactlyOnceWith({ environmentId, id });
        }
      } finally {
        await act(async () => renderer?.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
});
