// @vitest-environment jsdom

import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import {
  ComposerRunningModelMenuContent,
  ComposerRunningModelStrip,
} from "./ComposerRunningModelStrip";
import { deriveRunningModelStrip } from "./composerRunningModel";

const provider = ProviderInstanceId.make("codex");
const child = ThreadId.make("child");
const view = deriveRunningModelStrip({
  phase: "running",
  hasPendingApproval: false,
  hasPendingUserInput: false,
  requestedSelection: { instanceId: provider, model: "Done and copy" },
  servedModel: { model: "actually-served" },
  entries: [],
  delegatedRuns: [
    { threadId: child, instanceId: provider, model: "delegate and copy", status: "running" },
    {
      threadId: ThreadId.make("finished"),
      instanceId: provider,
      model: "finished",
      status: "completed",
    },
  ],
  subagents: [{ id: "native", title: "Task and copy", model: "native-model", status: "waiting" }],
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("running model chip and overflow", () => {
  it("opens the model/status list, retains completed children and preserves dynamic names", async () => {
    const opened = vi.fn();
    await act(() =>
      root.render(
        <ComposerRunningModelStrip
          view={view}
          onOpenDelegatedThread={opened}
          onOpenSubagents={() => {}}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.textContent).toBe("親actually-served＋サブ1");
    await act(() => trigger.click());
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("Done and copy");
    expect(menu.textContent).toContain("指定と異なります");
    expect(menu.textContent).toContain("delegate and copy");
    expect(menu.textContent).toContain("finished");
    const delegated = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes("delegate and copy"),
    )!;
    await act(() => delegated.click());
    expect(opened).toHaveBeenCalledWith(child);
  });

  it("keeps the same model list and Agents entry reachable in the compact overflow", async () => {
    const openedAgents = vi.fn();
    await act(() =>
      root.render(
        <CompactComposerControlsMenu
          interactionMode="default"
          runtimeMode="full-access"
          showInteractionModeToggle={false}
          onToggleInteractionMode={() => {}}
          onRuntimeModeChange={() => {}}
          runningModelMenuContent={
            <ComposerRunningModelMenuContent
              view={view}
              onOpenDelegatedThread={() => {}}
              onOpenSubagents={openedAgents}
            />
          }
        />,
      ),
    );
    await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("フルアクセス");
    expect(menu.textContent).toContain("actually-served");
    expect(menu.textContent).toContain("実行中");
    const native = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes("native-model"),
    )!;
    await act(() => native.click());
    expect(openedAgents).toHaveBeenCalledOnce();
  });
});
