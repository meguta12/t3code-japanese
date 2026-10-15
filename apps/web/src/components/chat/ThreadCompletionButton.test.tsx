import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const io = vi.hoisted(() => ({
  thread: null as EnvironmentThreadShell | null,
  threads: [] as EnvironmentThreadShell[],
  supportsSettlement: true,
  settle: vi.fn(),
  reopen: vi.fn(),
  newThread: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  location: { href: "/env-a/thread-a" },
}));

vi.mock("~/state/entities", () => ({
  useThreadShell: () => io.thread,
  useServerConfigs: () =>
    new Map([["env-a", { environment: { capabilities: { threadSettlement: io.supportsSettlement } } }]]),
  readEnvironmentSupportsSettlement: () => io.supportsSettlement,
  readThreadShell: () => io.thread,
  readThreadShells: () => io.threads,
}));
vi.mock("~/hooks/useThreadActions", () => ({
  useThreadActions: () => ({ settleThread: io.settle, unsettleThread: io.reopen }),
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => io.newThread }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { location: io.location }, navigate: io.navigate }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipTrigger: "div",
  TooltipPopup: "span",
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: (...args: unknown[]) => io.toast(...args) },
}));

import {
  findNextThreadAfterCompletion,
  threadCompletionBlockReason,
  ThreadCompletionButton,
} from "./ThreadCompletionButton";

const NOW = "2026-10-04T12:00:00.000Z";
const environmentId = EnvironmentId.make("env-a");
const projectId = ProjectId.make("project-a");
const threadId = ThreadId.make("thread-a");
const threadRef = scopeThreadRef(environmentId, threadId);

function makeThread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId,
    id: threadId,
    projectId,
    title: "Current work",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-02T12:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

let renderer: ReactTestRenderer | undefined;
async function mount() {
  await act(() => {
    renderer = create(<ThreadCompletionButton threadRef={threadRef} compact={false} />);
  });
}
function button() {
  return renderer!.root.findByType("button");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.setSystemTime(new Date(NOW));
  io.thread = makeThread();
  io.threads = [];
  io.supportsSettlement = true;
  io.location.href = "/env-a/thread-a";
  for (const mock of [io.settle, io.reopen, io.newThread, io.navigate, io.toast]) mock.mockReset();
  io.settle.mockImplementation(async () => {
    io.thread = { ...io.thread!, settledOverride: "settled", settledAt: NOW };
    return AsyncResult.success(undefined);
  });
  io.reopen.mockResolvedValue(AsyncResult.success(undefined));
  io.navigate.mockResolvedValue(undefined);
  io.newThread.mockResolvedValue(undefined);
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("completion eligibility", () => {
  it.each(["starting", "running"] as const)("keeps %s sessions visible", (status) => {
    const thread = makeThread({
      session: {
        threadId,
        status,
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(threadCompletionBlockReason(thread, NOW)).toContain("作業中");
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { backgroundLiveness: "working" as const },
    { backgroundLiveness: "monitoring" as const },
    { latestUserMessageAt: NOW },
  ])("blocks unsettled work before sending a command: %j", async (overrides) => {
    io.thread = makeThread(overrides);
    await mount();
    expect(button().props.disabled).toBe(true);
    await act(() => button().props.onClick());
    expect(io.settle).not.toHaveBeenCalled();
  });

  it("stops treating an abandoned start as queued after the adoption grace", () => {
    const thread = makeThread({ latestUserMessageAt: "2026-10-04T11:57:59.000Z" });
    expect(threadCompletionBlockReason(thread, NOW)).toBeNull();
  });
});

describe("completion navigation", () => {
  it("chooses the most recently used unfinished conversation in the same project and environment", () => {
    const next = makeThread({ id: ThreadId.make("next"), latestUserMessageAt: "2026-10-04T11:00:00Z" });
    const candidates = [
      makeThread({ id: ThreadId.make("older") }),
      next,
      makeThread({ id: ThreadId.make("done"), settledOverride: "settled", updatedAt: NOW }),
      makeThread({ id: ThreadId.make("archived"), archivedAt: NOW, updatedAt: NOW }),
      makeThread({ id: ThreadId.make("snoozed"), snoozedUntil: "2026-10-05T12:00:00Z", updatedAt: NOW }),
      makeThread({ id: ThreadId.make("other-project"), projectId: ProjectId.make("other"), updatedAt: NOW }),
      makeThread({ id: threadId, environmentId: EnvironmentId.make("env-b"), updatedAt: NOW }),
    ];
    expect(findNextThreadAfterCompletion(makeThread(), candidates, NOW)).toBe(next);
  });

  it("navigates to another unfinished conversation only after completion succeeds", async () => {
    io.threads = [makeThread({ id: ThreadId.make("next") })];
    await mount();
    await act(() => button().props.onClick());
    expect(io.settle).toHaveBeenCalledWith(threadRef);
    expect(io.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: "next" },
    });
    expect(io.newThread).not.toHaveBeenCalled();
  });

  it("opens the existing project draft when no unfinished conversation remains", async () => {
    await mount();
    await act(() => button().props.onClick());
    expect(io.newThread).toHaveBeenCalledWith({ environmentId, projectId });
  });

  it("preserves navigation made while the completion request is pending", async () => {
    io.settle.mockImplementation(async () => {
      io.location.href = "/env-a/elsewhere";
      io.thread = { ...io.thread!, settledOverride: "settled" };
      return AsyncResult.success(undefined);
    });
    await mount();
    await act(() => button().props.onClick());
    expect(io.newThread).not.toHaveBeenCalled();
    expect(io.navigate).not.toHaveBeenCalled();
  });

  it("stays put when another device or Undo reopens the conversation", async () => {
    io.settle.mockResolvedValue(AsyncResult.success(undefined));
    await mount();
    await act(() => button().props.onClick());
    expect(io.newThread).not.toHaveBeenCalled();
    expect(io.navigate).not.toHaveBeenCalled();
  });

  it("reports a failed completion and keeps the conversation open", async () => {
    io.settle.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("rejected"))));
    await mount();
    await act(() => button().props.onClick());
    expect(io.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "rejected" }));
    expect(io.navigate).not.toHaveBeenCalled();
    expect(io.newThread).not.toHaveBeenCalled();
  });

  it("distinguishes completed work from a subsequent navigation failure", async () => {
    io.newThread.mockRejectedValue(new Error("route unavailable"));
    await mount();
    await act(() => button().props.onClick());
    expect(io.thread?.settledOverride).toBe("settled");
    expect(io.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "作業は完了しましたが、画面を切り替えられませんでした" }),
    );
  });

  it("reopens in place and updates the action when the shell changes", async () => {
    await mount();
    io.thread = makeThread({ settledOverride: "settled", settledAt: NOW });
    await act(() => renderer!.update(<ThreadCompletionButton threadRef={threadRef} compact={false} />));
    expect(button().props["aria-label"]).toBe("作業を再開");
    await act(() => button().props.onClick());
    expect(io.reopen).toHaveBeenCalledWith(threadRef);
    expect(io.navigate).not.toHaveBeenCalled();
    expect(io.newThread).not.toHaveBeenCalled();
  });

  it("hides the action and sends no RPC to a server without settlement support", async () => {
    io.supportsSettlement = false;
    await mount();
    expect(renderer!.toJSON()).toBeNull();
    expect(io.settle).not.toHaveBeenCalled();
  });
});
