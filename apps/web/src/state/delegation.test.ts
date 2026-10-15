import { ProviderInstanceId, ThreadId, type DelegationStartedPayload } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { DelegatedChildShell } from "../lib/delegation";
import { createDelegatedRunsAtom } from "./delegation";

const childId = ThreadId.make("child");
const otherChildId = ThreadId.make("other-child");
const start: DelegationStartedPayload = {
  childThreadId: childId,
  title: "child",
  provider: ProviderInstanceId.make("codex"),
  model: "sol",
  effort: null,
  createdAt: "2026-10-11T00:00:01.000Z",
};
const running: DelegatedChildShell = {
  latestTurn: { state: "running", requestedAt: start.createdAt },
  latestUserMessageAt: start.createdAt,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

function harness() {
  const registry = AtomRegistry.make();
  const startsAtom = Atom.make<ReadonlyArray<DelegationStartedPayload>>([start]);
  const childShell = Atom.make<DelegatedChildShell | null>(null);
  const otherChildShell = Atom.make<DelegatedChildShell | null>(null);
  const shellLiveAtom = Atom.make(false);
  const removedChildIdsAtom = Atom.make<ReadonlySet<ThreadId>>(new Set<ThreadId>());
  const unloadedShells = Atom.make<
    Option.Option<ReadonlyMap<ThreadId, DelegatedChildShell | null>>
  >(Option.none());
  let requestedStarts: ReadonlyArray<DelegationStartedPayload> = [];
  let queryCalls = 0;
  const runs = createDelegatedRunsAtom({
    startsAtom,
    childShellAtom: (id) => (id === childId ? childShell : otherChildShell),
    shellLiveAtom,
    removedChildIdsAtom,
    unloadedShellsAtom: (starts) => {
      queryCalls += 1;
      requestedStarts = starts;
      return unloadedShells;
    },
  });
  const unmount = registry.mount(runs);
  return {
    registry,
    startsAtom,
    childShell,
    otherChildShell,
    shellLiveAtom,
    removedChildIdsAtom,
    unloadedShells,
    runs,
    unmount,
    requestedStarts: () => requestedStarts,
    queryCalls: () => queryCalls,
  };
}

describe("delegated footer read model", () => {
  it("preserves a child until its shell loads and removes it only after authoritative absence", () => {
    const h = harness();
    expect(h.registry.get(h.runs)[0]?.status).toBe("queued");
    h.registry.set(h.shellLiveAtom, true);

    expect(h.registry.get(h.runs)[0]?.status).toBe("queued");
    h.registry.set(h.childShell, running);
    expect(h.registry.get(h.runs)[0]?.status).toBe("running");

    h.registry.set(h.childShell, null);
    expect(h.registry.get(h.runs)).toEqual([]);
    h.unmount();
    h.registry.dispose();
  });

  it("does not resurrect a completed child while the shell reconnects", () => {
    const h = harness();
    h.registry.set(h.shellLiveAtom, true);
    h.registry.set(h.childShell, {
      ...running,
      latestTurn: { ...running.latestTurn!, state: "completed" },
    });
    const completed = h.registry.get(h.runs);
    expect(completed[0]?.status).toBe("completed");
    h.registry.set(h.shellLiveAtom, false);
    h.registry.set(h.childShell, null);
    expect(h.registry.get(h.runs)).toBe(completed);
    h.unmount();
    h.registry.dispose();
  });

  it("preserves an unobserved child when a parent upsert arrives first or HTTP loading fails", () => {
    const h = harness();
    h.registry.set(h.shellLiveAtom, true);
    expect(h.registry.get(h.runs)[0]?.status).toBe("queued");
    expect(h.requestedStarts()).toEqual([start]);
    // The parent can refetch its newest timestamp while the child frame is still missing.
    h.registry.set(h.startsAtom, [{ ...start }]);
    h.registry.set(h.unloadedShells, Option.none());
    expect(h.registry.get(h.runs)[0]?.status).toBe("queued");
    h.unmount();
    h.registry.dispose();
  });

  it("uses authoritative HTTP child state until its live shell arrives, then prefers live updates", () => {
    const h = harness();
    h.registry.set(h.shellLiveAtom, true);
    h.registry.set(
      h.unloadedShells,
      Option.some(
        new Map([
          [
            childId,
            {
              ...running,
              modelSelection: {
                instanceId: ProviderInstanceId.make("claude"),
                model: "http-model",
              },
            },
          ],
        ]),
      ),
    );
    expect(h.registry.get(h.runs)[0]).toMatchObject({ model: "http-model", status: "running" });
    h.registry.set(h.childShell, {
      ...running,
      modelSelection: { instanceId: start.provider, model: "live-model" },
      hasPendingApprovals: true,
    });
    expect(h.registry.get(h.runs)[0]).toMatchObject({ model: "live-model", status: "awaiting" });
    h.unmount();
    h.registry.dispose();
  });

  it("keeps authoritative completed children completed and removes authoritative absent children", () => {
    const h = harness();
    h.registry.set(h.shellLiveAtom, true);
    h.registry.set(
      h.unloadedShells,
      Option.some(
        new Map([
          [childId, { ...running, latestTurn: { ...running.latestTurn!, state: "completed" } }],
        ]),
      ),
    );
    const completed = h.registry.get(h.runs);
    expect(completed[0]?.status).toBe("completed");
    h.registry.set(h.unloadedShells, Option.none());
    expect(h.registry.get(h.runs)).toBe(completed);
    h.registry.set(h.unloadedShells, Option.some(new Map([[childId, null]])));
    expect(h.registry.get(h.runs)).toEqual([]);
    h.registry.set(h.unloadedShells, Option.none());
    expect(h.registry.get(h.runs)).toEqual([]);
    h.registry.set(h.shellLiveAtom, false);
    h.registry.set(h.childShell, running);
    expect(h.registry.get(h.runs)).toEqual([]);
    h.unmount();
    h.registry.dispose();
  });

  it("holds an observed result through cached/synchronizing shells and removes it after live absence", () => {
    const h = harness();
    h.registry.set(h.shellLiveAtom, true);
    h.registry.set(h.childShell, running);
    const first = h.registry.get(h.runs);
    h.registry.set(h.shellLiveAtom, false);
    h.registry.set(h.childShell, null);
    expect(h.registry.get(h.runs)).toBe(first);
    h.registry.set(h.shellLiveAtom, true);
    expect(h.registry.get(h.runs)).toEqual([]);
    h.unmount();
    h.registry.dispose();
  });

  it("does not notify or replace the view when unrelated thread values change", () => {
    const h = harness();
    h.registry.set(h.shellLiveAtom, true);
    h.registry.set(h.childShell, running);
    const first = h.registry.get(h.runs);
    let changes = 0;
    const unsubscribe = h.registry.subscribe(h.runs, () => {
      changes += 1;
    });
    h.registry.set(h.startsAtom, [{ ...start }]);
    h.registry.set(h.childShell, { ...running, latestTurn: { ...running.latestTurn! } });

    expect(h.registry.get(h.runs)).toBe(first);
    expect(changes).toBe(0);
    h.registry.set(h.childShell, { ...running, hasPendingUserInput: true });
    expect(h.registry.get(h.runs)[0]?.status).toBe("awaiting");
    expect(changes).toBe(1);
    unsubscribe();
    h.unmount();
    h.registry.dispose();
  });

  it("does not query confirmed absent children again when another child arrives and accepts a live return", () => {
    const h = harness();
    const otherStart = { ...start, childThreadId: otherChildId };
    h.registry.set(h.startsAtom, [start, otherStart]);
    h.registry.set(h.shellLiveAtom, true);
    h.registry.set(
      h.unloadedShells,
      Option.some(
        new Map([
          [childId, null],
          [otherChildId, running],
        ]),
      ),
    );
    expect(h.registry.get(h.runs).map((run) => run.threadId)).toEqual([otherChildId]);
    const calls = h.queryCalls();
    h.registry.set(h.otherChildShell, running);
    h.registry.set(h.startsAtom, [{ ...start }, { ...otherStart }]);
    h.registry.set(h.otherChildShell, { ...running, latestTurn: { ...running.latestTurn! } });
    expect(h.registry.get(h.runs).map((run) => run.threadId)).toEqual([otherChildId]);
    expect(h.queryCalls()).toBe(calls);
    h.registry.set(h.childShell, running);
    expect(h.registry.get(h.runs).map((run) => run.threadId)).toEqual([childId, otherChildId]);
    expect(h.queryCalls()).toBe(calls);
    h.unmount();
    h.registry.dispose();
  });

  it("removes an HTTP running fallback on raw removal even before the child shell was ever observed", () => {
    const h = harness();
    h.registry.set(h.shellLiveAtom, true);
    h.registry.set(h.unloadedShells, Option.some(new Map([[childId, running]])));
    expect(h.registry.get(h.runs)[0]?.status).toBe("running");
    const calls = h.queryCalls();
    h.registry.set(h.removedChildIdsAtom, new Set([childId]));
    expect(h.registry.get(h.runs)).toEqual([]);
    expect(h.queryCalls()).toBe(calls);
    h.registry.set(h.childShell, running);
    expect(h.registry.get(h.runs)[0]?.status).toBe("running");
    expect(h.queryCalls()).toBe(calls);
    h.unmount();
    h.registry.dispose();
  });
});
