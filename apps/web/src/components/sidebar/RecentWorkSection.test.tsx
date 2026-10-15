import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { RECENT_WORK_RETENTION_MS } from "../../lib/recentThreads";
import { RecentWorkSection } from "./RecentWorkSection";

const mocks = vi.hoisted(() => ({ configs: new Map() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.configs }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("./ProviderThreadIcon", () => ({ ProviderThreadIcon: () => null }));
vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
let renderer: ReactTestRenderer | undefined;

function work(activityAt: number): EnvironmentThreadShell {
  return {
    id: ThreadId.make("work"),
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project"),
    title: "New work",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
    createdAt: new Date(activityAt).toISOString(),
    updatedAt: new Date(activityAt).toISOString(),
    latestUserMessageAt: new Date(activityAt).toISOString(),
    latestTurn: null,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    branch: null,
    worktreePath: null,
    pullRequests: [],
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const windowEvents = new EventTarget();
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  });
  vi.stubGlobal("document", new EventTarget());
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function visibleWorkCount() {
  return renderer!.root.findAll(
    (node) => node.type === "button" && String(node.props["data-testid"] ?? "").startsWith("recent-work-"),
  ).length;
}

describe("recent work while the app stays open", () => {
  it("removes a session exactly at expiry without navigation or another server update", () => {
    act(() => {
      renderer = create(
        <RecentWorkSection threads={[work(NOW - RECENT_WORK_RETENTION_MS + 10_000)]} onNavigateToThread={() => {}} />,
      );
    });
    expect(visibleWorkCount()).toBe(1);
    act(() => vi.advanceTimersByTime(10_000));
    expect(visibleWorkCount()).toBe(0);
  });

  it("shows newly active work after an empty shelf has stayed open with no timer", () => {
    act(() => {
      renderer = create(<RecentWorkSection threads={[]} onNavigateToThread={() => {}} />);
    });
    act(() => vi.advanceTimersByTime(60_000));
    act(() => {
      renderer!.update(<RecentWorkSection threads={[work(Date.now())]} onNavigateToThread={() => {}} />);
    });
    expect(visibleWorkCount()).toBe(1);
  });
});
