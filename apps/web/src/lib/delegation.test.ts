import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveDelegatedAgents,
  deriveDelegatedRunStatus,
  deriveDelegatedRuns,
  deriveDelegationOrigin,
  deriveDelegationStarts,
  delegatedRunsEqual,
  isPresetModelOffered,
  nextPresetName,
  validatePresetName,
  type DelegatedChildShell,
} from "./delegation";

const codex = ProviderInstanceId.make("codex");
const child = (value: string) => ThreadId.make(value);

const started = (childThreadId: string, createdAt: string, extra: object = {}) => ({
  kind: "delegation.started",
  createdAt,
  payload: {
    childThreadId,
    title: "[委譲] 実装",
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "ultra",
    createdAt,
    ...extra,
  },
});

const shell = (overrides: Partial<DelegatedChildShell> = {}): DelegatedChildShell => ({
  latestTurn: { state: "completed", requestedAt: "2026-10-06T10:00:00.000Z" },
  latestUserMessageAt: "2026-10-06T09:59:59.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...overrides,
});

describe("deriveDelegatedRunStatus", () => {
  it("preserves a follow-up's failure or cancellation after its pending slot is cleared", () => {
    for (const [status, expected] of [
      ["error", "error"],
      ["stopped", "interrupted"],
    ] as const) {
      expect(
        deriveDelegatedRunStatus(
          shell({
            hasPendingTurnStart: false,
            latestUserMessageAt: "2026-10-06T10:01:00.000Z",
            session: { status, updatedAt: "2026-10-06T10:02:00.000Z" },
          }),
        ),
      ).toBe(expected);
    }
  });

  it("does not keep a cancelled queued message running after the previous turn completes", () => {
    expect(
      deriveDelegatedRunStatus(
        shell({ latestUserMessageAt: "2026-10-06T10:01:00.000Z", hasPendingTurnStart: false }),
      ),
    ).toBe("completed");
  });

  it("reports startup failure and pre-start cancellation instead of running forever", () => {
    expect(
      deriveDelegatedRunStatus(
        shell({
          latestTurn: null,
          session: { status: "error", updatedAt: "2026-10-06T10:00:00.000Z" },
        }),
      ),
    ).toBe("error");
    expect(
      deriveDelegatedRunStatus(
        shell({
          latestTurn: null,
          session: { status: "stopped", updatedAt: "2026-10-06T10:00:00.000Z" },
        }),
      ),
    ).toBe("interrupted");
    expect(
      deriveDelegatedRunStatus(
        shell({
          latestUserMessageAt: "2026-10-06T10:01:00.000Z",
          session: { status: "stopped", updatedAt: "2026-10-06T10:02:00.000Z" },
        }),
      ),
    ).toBe("interrupted");
  });

  it("follows the latest turn state", () => {
    expect(deriveDelegatedRunStatus(shell())).toBe("completed");
    expect(
      deriveDelegatedRunStatus(
        shell({ latestTurn: { state: "running", requestedAt: "2026-10-06T10:00:00.000Z" } }),
      ),
    ).toBe("running");
    expect(
      deriveDelegatedRunStatus(
        shell({ latestTurn: { state: "error", requestedAt: "2026-10-06T10:00:00.000Z" } }),
      ),
    ).toBe("error");
    expect(
      deriveDelegatedRunStatus(
        shell({ latestTurn: { state: "interrupted", requestedAt: "2026-10-06T10:00:00.000Z" } }),
      ),
    ).toBe("interrupted");
  });

  it("needs the user whenever an approval or a question is pending, even mid-turn", () => {
    const running = { state: "running", requestedAt: "2026-10-06T10:00:00.000Z" } as const;
    expect(
      deriveDelegatedRunStatus(shell({ latestTurn: running, hasPendingApprovals: true })),
    ).toBe("awaiting");
    expect(deriveDelegatedRunStatus(shell({ hasPendingUserInput: true }))).toBe("awaiting");
  });

  it("treats a follow-up sent after the last turn was requested as running again", () => {
    expect(
      deriveDelegatedRunStatus(shell({ latestUserMessageAt: "2026-10-06T10:05:00.000Z" })),
    ).toBe("running");
    expect(
      deriveDelegatedRunStatus(
        shell({
          latestTurn: { state: "error", requestedAt: "2026-10-06T10:00:00.000Z" },
          latestUserMessageAt: "2026-10-06T10:00:00.001Z",
        }),
      ),
    ).toBe("running");
    // The message that started the turn is not a follow-up.
    expect(
      deriveDelegatedRunStatus(shell({ latestUserMessageAt: "2026-10-06T10:00:00.000Z" })),
    ).toBe("completed");
  });

  it("treats a child with no turn yet as starting", () => {
    expect(deriveDelegatedRunStatus(shell({ latestTurn: null, latestUserMessageAt: null }))).toBe(
      "running",
    );
  });
});

describe("deriveDelegationStarts", () => {
  it("keeps one entry per child, oldest first, and skips other or malformed activities", () => {
    const starts = deriveDelegationStarts([
      started("c2", "2026-10-06T10:02:00.000Z"),
      started("c1", "2026-10-06T10:01:00.000Z", { presetName: "実装役", effort: null }),
      started("c1", "2026-10-06T10:03:00.000Z"),
      { kind: "delegation.started", createdAt: "2026-10-06T10:04:00.000Z", payload: { nope: 1 } },
      { kind: "tool.completed", createdAt: "2026-10-06T10:05:00.000Z", payload: {} },
    ]);
    expect(starts.map((start) => start.childThreadId)).toEqual(["c1", "c2"]);
    expect(starts[0]).toMatchObject({ presetName: "実装役", effort: null });
  });
});

describe("deriveDelegationOrigin", () => {
  it("reads the parent from delegation.origin and ignores ordinary threads", () => {
    expect(
      deriveDelegationOrigin([
        { kind: "delegation.origin", createdAt: "x", payload: { parentThreadId: "p1" } },
      ]),
    ).toBe("p1");
    expect(deriveDelegationOrigin([{ kind: "tool.completed", createdAt: "x", payload: {} }])).toBe(
      null,
    );
    expect(
      deriveDelegationOrigin([{ kind: "delegation.origin", createdAt: "x", payload: {} }]),
    ).toBe(null);
  });
});

describe("deriveDelegatedRuns", () => {
  const starts = deriveDelegationStarts([
    started("c1", "2026-10-06T10:01:00.000Z"),
    started("c2", "2026-10-06T10:02:00.000Z"),
  ]);

  it("drops children whose thread no longer exists", () => {
    const runs = deriveDelegatedRuns(starts, (id) => (id === "c2" ? shell() : null));
    expect(runs).toEqual([
      {
        threadId: child("c2"),
        title: "[委譲] 実装",
        instanceId: codex,
        model: "gpt-6.1-sol",
        effort: "ultra",
        status: "completed",
      },
    ]);
  });

  it("compares runs by what the strip shows", () => {
    const a = deriveDelegatedRuns(starts, () => shell());
    const b = deriveDelegatedRuns(starts, () => shell());
    const c = deriveDelegatedRuns(starts, () => shell({ hasPendingApprovals: true }));
    expect(delegatedRunsEqual(a, b)).toBe(true);
    expect(delegatedRunsEqual(a, c)).toBe(false);
    expect(delegatedRunsEqual(a, a.slice(1))).toBe(false);
  });

  it("keeps a child while its shell has not loaded, distinct from a removed child", () => {
    const runs = deriveDelegatedRuns(starts, (id) => (id === "c2" ? null : undefined));
    expect(runs).toEqual([
      {
        threadId: child("c1"),
        title: "[委譲] 実装",
        instanceId: codex,
        model: "gpt-6.1-sol",
        effort: "ultra",
        status: "queued",
      },
    ]);
  });

  it("retains the known terminal result during shell reconnection instead of counting it again", () => {
    const previous = deriveDelegatedRuns(starts, () => shell());
    expect(deriveDelegatedRuns(starts, () => undefined, previous)).toEqual(previous);
    expect(deriveDelegatedRuns(starts, () => null, previous)).toEqual([]);
  });

  it("follows the child's current model when a follow-up changes its provider or selection", () => {
    const instanceId = ProviderInstanceId.make("claude");
    const runs = deriveDelegatedRuns(starts, () =>
      shell({
        hasPendingUserInput: true,
        modelSelection: {
          instanceId,
          model: "Done and copy",
          options: [{ id: "effort", value: "high" }],
        },
      }),
    );
    expect(runs[0]).toMatchObject({
      instanceId,
      model: "Done and copy",
      effort: "high",
      status: "awaiting",
    });
  });
});

describe("validatePresetName", () => {
  const presets = [
    { id: "a", name: "実装役" },
    { id: "b", name: "Review" },
  ];

  it("rejects empty and whitespace-only names", () => {
    expect(validatePresetName("", "a", presets)).toBe("empty");
    expect(validatePresetName("  　 ", "a", presets)).toBe("empty");
  });

  it("rejects another preset's name regardless of case, width and spacing", () => {
    expect(validatePresetName("review", "a", presets)).toBe("duplicate");
    expect(validatePresetName("ＲＥＶＩＥＷ", "a", presets)).toBe("duplicate");
    expect(validatePresetName(" Review ", "a", presets)).toBe("duplicate");
  });

  it("lets a preset keep or re-case its own name", () => {
    expect(validatePresetName("実装役", "a", presets)).toBeNull();
    expect(validatePresetName("review", "b", presets)).toBeNull();
    expect(validatePresetName("テスト役", "a", presets)).toBeNull();
  });
});

describe("nextPresetName", () => {
  it("starts at 役割1 and skips taken numbers", () => {
    expect(nextPresetName([])).toBe("役割1");
    expect(nextPresetName([{ name: "役割1" }, { name: "役割3" }])).toBe("役割2");
    expect(nextPresetName([{ name: "役割１" }])).toBe("役割2");
  });
});

describe("isPresetModelOffered", () => {
  const entry = { enabled: true, isAvailable: true };
  const options = [{ slug: "sol" }, { slug: "gone", isUnavailable: true }];

  it("needs an enabled, available instance that lists the model", () => {
    expect(isPresetModelOffered({ entry, options, model: "sol" })).toBe(true);
    expect(isPresetModelOffered({ entry, options, model: "gone" })).toBe(false);
    expect(isPresetModelOffered({ entry, options, model: "unknown" })).toBe(false);
    expect(isPresetModelOffered({ entry: undefined, options, model: "sol" })).toBe(false);
    expect(
      isPresetModelOffered({ entry: { enabled: false, isAvailable: true }, options, model: "sol" }),
    ).toBe(false);
    expect(isPresetModelOffered({ entry, options: undefined, model: "sol" })).toBe(false);
  });
});

describe("deriveDelegatedAgents", () => {
  it("lists each delegated child as an Agents panel row linked to its thread", () => {
    const starts = deriveDelegationStarts([
      started("child-a", "2026-10-06T10:00:00.000Z", { presetName: "実装役" }),
      started("child-b", "2026-10-06T10:01:00.000Z"),
    ]);
    const agents = deriveDelegatedAgents(starts, [
      { threadId: child("child-a"), instanceId: codex, model: "gpt-6.1-sol", status: "awaiting" },
      {
        threadId: child("child-b"),
        instanceId: codex,
        model: "gpt-6.1-sol",
        effort: "ultra",
        status: "error",
      },
    ]);

    expect(
      agents.map(({ delegatedThreadId, role, status, startedAt }) => ({
        delegatedThreadId,
        role,
        status,
        startedAt,
      })),
    ).toEqual([
      {
        delegatedThreadId: "child-a",
        role: "実装役",
        status: "waiting",
        startedAt: "2026-10-06T10:00:00.000Z",
      },
      { delegatedThreadId: "child-b", role: "codex", status: "failed", startedAt: null },
    ]);
  });

  it("skips runs whose start activity is no longer loaded", () => {
    expect(
      deriveDelegatedAgents(
        [],
        [{ threadId: child("child-a"), instanceId: codex, model: "m", status: "running" }],
      ),
    ).toEqual([]);
  });
});
