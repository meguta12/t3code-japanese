import {
  createDelegationColorMap,
  delegationFamilyKey,
  fallbackDelegationColor,
} from "../lib/delegationGroups";
import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import {
  EnvironmentId,
  ThreadId,
  type DelegationStartedPayload,
  type OrchestrationShellSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { DelegatedChildRun } from "../components/chat/composerRunningModel";
import {
  deriveDelegatedRuns,
  deriveDelegationOrigin,
  deriveDelegationStarts,
  delegatedRunsEqual,
  type DelegatedChildShell,
} from "../lib/delegation";
import { environmentShell } from "./shell";
import { environmentSession } from "./session";
import { environmentThreadDetails, environmentThreadShells } from "./threads";
import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Delegation read models. Both selectors return the previous value while the
 * figures they show are unchanged, so streaming activity on the thread never
 * re-renders the composer strip or the header.
 */

const EMPTY_RUNS: ReadonlyArray<DelegatedChildRun> = Object.freeze([]);
const EMPTY_RUNS_ATOM = Atom.make(EMPTY_RUNS).pipe(Atom.withLabel("delegated-runs:empty"));
const EMPTY_REMOVED_CHILD_IDS: ReadonlySet<ThreadId> = new Set();

type UnloadedChildShells = ReadonlyMap<ThreadId, DelegatedChildShell | null>;

/** Retain only the requested children's display state, never the full environment snapshot. */
export function selectUnloadedChildShells(
  childIds: ReadonlyArray<ThreadId>,
  snapshot: OrchestrationShellSnapshot,
): UnloadedChildShells {
  const wanted = new Set(childIds);
  const found = new Map<ThreadId, DelegatedChildShell | null>(childIds.map((id) => [id, null]));
  for (const shell of snapshot.threads) {
    if (!wanted.has(shell.id)) continue;
    found.set(shell.id, {
      modelSelection: shell.modelSelection,
      session: shell.session,
      hasPendingTurnStart: shell.hasPendingTurnStart,
      latestTurn:
        shell.latestTurn === null
          ? null
          : {
              state: shell.latestTurn.state,
              requestedAt: shell.latestTurn.requestedAt,
            },
      latestUserMessageAt: shell.latestUserMessageAt,
      hasPendingApprovals: shell.hasPendingApprovals,
      hasPendingUserInput: shell.hasPendingUserInput,
    });
  }
  return found;
}

// Generated internally from an environment and the missing children's stable starts.
type UnloadedChildKey = {
  readonly environmentId: string;
  readonly children: ReadonlyArray<readonly [string, string]>;
};

const unloadedChildShellsAtomFamily = Atom.family((key: string) => {
  const { environmentId: environmentKey, children } = JSON.parse(key) as UnloadedChildKey;
  const environmentId = EnvironmentId.make(environmentKey);
  const childIds = children.map(([id]) => ThreadId.make(id));
  const query = connectionAtomRuntime
    .atom((get) => {
      const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (Option.isNone(prepared)) return Effect.succeed(Option.none<UnloadedChildShells>());
      return Effect.gen(function* () {
        const loader = yield* ShellSnapshotLoader;
        const snapshot = yield* loader.load(prepared.value);
        return Option.map(snapshot, (value) => selectUnloadedChildShells(childIds, value));
      });
    })
    .pipe(Atom.setIdleTTL(300_000));
  return Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(query)), () => Option.none<UnloadedChildShells>()),
  ).pipe(Atom.setIdleTTL(300_000), Atom.withLabel(`delegated-unloaded-shells:${key}`));
});

/** Child shell reads stay narrow; only changed model/status values notify React. */
export function createDelegatedRunsAtom(input: {
  readonly startsAtom: Atom.Atom<ReadonlyArray<DelegationStartedPayload>>;
  readonly childShellAtom: (threadId: ThreadId) => Atom.Atom<DelegatedChildShell | null>;
  readonly shellLiveAtom: Atom.Atom<boolean>;
  readonly removedChildIdsAtom: Atom.Atom<ReadonlySet<ThreadId>>;
  readonly unloadedShellsAtom: (
    starts: ReadonlyArray<DelegationStartedPayload>,
  ) => Atom.Atom<Option.Option<UnloadedChildShells>>;
}) {
  let previous = EMPTY_RUNS;
  const observedLiveChildren = new Set<ThreadId>();
  const confirmedAbsentChildren = new Set<ThreadId>();
  return Atom.make((get) => {
    const starts = get(input.startsAtom);
    const live = get(input.shellLiveAtom);
    const removedChildIds = get(input.removedChildIdsAtom);
    const shells = new Map(
      starts.map((start) => {
        const shell = get(input.childShellAtom(start.childThreadId));
        if (live && shell !== null) {
          observedLiveChildren.add(start.childThreadId);
          confirmedAbsentChildren.delete(start.childThreadId);
        } else if (live && observedLiveChildren.has(start.childThreadId)) {
          confirmedAbsentChildren.add(start.childThreadId);
        } else if (shell === null && removedChildIds.has(start.childThreadId)) {
          confirmedAbsentChildren.add(start.childThreadId);
        }
        return [start.childThreadId, shell] as const;
      }),
    );
    const unloadedStarts = starts.filter(
      (start) =>
        shells.get(start.childThreadId) === null &&
        !observedLiveChildren.has(start.childThreadId) &&
        !confirmedAbsentChildren.has(start.childThreadId),
    );
    const unloaded =
      unloadedStarts.length === 0
        ? Option.none<UnloadedChildShells>()
        : get(input.unloadedShellsAtom(unloadedStarts));
    if (Option.isSome(unloaded)) {
      for (const [threadId, shell] of unloaded.value) {
        if (shell === null) confirmedAbsentChildren.add(threadId);
      }
    }
    const next =
      starts.length === 0
        ? EMPTY_RUNS
        : deriveDelegatedRuns(
            starts,
            (childThreadId) => {
              const shell = shells.get(childThreadId);
              if (shell !== null && shell !== undefined) {
                if (!live && confirmedAbsentChildren.has(childThreadId)) return null;
                // Cached shells cannot rewind a previously observed live result.
                return !live && previous.some((run) => run.threadId === childThreadId)
                  ? undefined
                  : shell;
              }
              if (observedLiveChildren.has(childThreadId)) return live ? null : undefined;
              if (confirmedAbsentChildren.has(childThreadId)) return null;
              // Parent shell timestamps do not prove child absence: an upsert
              // can refetch a newer parent before the child's own frame arrives.
              return Option.isSome(unloaded) ? unloaded.value.get(childThreadId) : undefined;
            },
            previous,
          );
    if (delegatedRunsEqual(previous, next)) return previous;
    previous = next;
    return next;
  });
}

const delegatedRunsAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  const startsAtom = Atom.make((get) =>
    deriveDelegationStarts(get(environmentThreadDetails.activitiesAtom(ref))),
  );
  return createDelegatedRunsAtom({
    startsAtom,
    childShellAtom: (threadId) =>
      environmentThreadShells.threadShellAtom({ environmentId: ref.environmentId, threadId }),
    shellLiveAtom: Atom.make(
      (get) => get(environmentShell.stateValueAtom(ref.environmentId)).status === "live",
    ),
    removedChildIdsAtom: Atom.make(
      (get) =>
        get(environmentShell.stateValueAtom(ref.environmentId)).removedThreadIds ??
        EMPTY_REMOVED_CHILD_IDS,
    ),
    unloadedShellsAtom: (starts) =>
      unloadedChildShellsAtomFamily(
        JSON.stringify({
          environmentId: ref.environmentId,
          children: starts
            .map((start) => [start.childThreadId, start.createdAt] as const)
            .toSorted(([left], [right]) => left.localeCompare(right)),
        } satisfies UnloadedChildKey),
      ),
  }).pipe(Atom.withLabel(`delegated-runs:${key}`));
});

/** Child threads this thread delegated to, with each child's status. Empty for most threads. */
export function useDelegatedRuns(ref: ScopedThreadRef | null): ReadonlyArray<DelegatedChildRun> {
  return useAtomValue(ref === null ? EMPTY_RUNS_ATOM : delegatedRunsAtomFamily(threadKey(ref)));
}

export interface DelegationOrigin {
  readonly parentThreadId: ThreadId;
  readonly parentTitle: string;
  readonly parentModel: string;
}

const NO_ORIGIN_ATOM = Atom.make<DelegationOrigin | null>(null).pipe(
  Atom.withLabel("delegation-origin:empty"),
);

const delegationOriginAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previous: DelegationOrigin | null = null;
  return Atom.make((get) => {
    const detail = get(environmentThreadDetails.detailAtom(ref));
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    const parentThreadId =
      shell?.delegationParentThreadId ??
      (detail === null ? null : deriveDelegationOrigin(detail.activities));
    // A parent that no longer exists leaves nothing to link to.
    const parent =
      parentThreadId === null
        ? null
        : get(
            environmentThreadShells.threadShellAtom({
              environmentId: ref.environmentId,
              threadId: parentThreadId,
            }),
          );
    const next =
      parentThreadId === null || parent === null
        ? null
        : { parentThreadId, parentTitle: parent.title, parentModel: parent.modelSelection.model };
    if (
      previous?.parentThreadId === next?.parentThreadId &&
      previous?.parentTitle === next?.parentTitle &&
      previous?.parentModel === next?.parentModel
    ) {
      return previous;
    }
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`delegation-origin:${key}`));
});

/** The parent a delegated child thread came from, or null for an ordinary thread. */
export function useDelegationOrigin(ref: ScopedThreadRef | null): DelegationOrigin | null {
  return useAtomValue(ref === null ? NO_ORIGIN_ATOM : delegationOriginAtomFamily(threadKey(ref)));
}

const familyColorsAtom = (() => {
  let previousKey = "";
  let colors: ReadonlyMap<string, string> = new Map();
  return Atom.make((get) => {
    const keys = [
      ...new Set(
        get(environmentThreadShells.threadShellsAtom)
          .filter((thread) => thread.delegationParentThreadId != null)
          .map(delegationFamilyKey),
      ),
    ].toSorted();
    const key = JSON.stringify(keys);
    if (key !== previousKey) {
      previousKey = key;
      colors = createDelegationColorMap(keys);
    }
    return colors;
  });
})();

export function useDelegationFamilyColor(key: string): string {
  return useAtomValue(familyColorsAtom).get(key) ?? fallbackDelegationColor(key);
}

const delegationIsChildAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    if (shell?.delegationParentThreadId != null) return true;
    const detail = get(environmentThreadDetails.detailAtom(ref));
    return detail !== null && deriveDelegationOrigin(detail.activities) !== null;
  });
});

/** The child's role survives an unavailable/deleted parent; navigation is a separate concern. */
export function useDelegationIsChild(ref: ScopedThreadRef): boolean {
  return useAtomValue(delegationIsChildAtomFamily(threadKey(ref)));
}
