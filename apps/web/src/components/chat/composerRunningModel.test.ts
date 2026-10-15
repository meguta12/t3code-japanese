import {
  ProviderDriverKind,
  EventId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  deriveRunningModelState,
  deriveRunningModelStrip,
  resolveRunningModelTarget,
  servedModelMismatch,
  createRunningModelStripSelector,
  deriveRunningSubagents,
  type RunningModelStripInput,
} from "./composerRunningModel";

const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");

const codexProvider: ServerProvider = {
  instanceId: codexId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-06T00:00:00.000Z",
  models: [
    {
      slug: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      aliases: ["sol"],
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "high", label: "High" },
              { id: "ultra", label: "Ultra" },
            ],
          },
          {
            id: "serviceTier",
            label: "Speed",
            type: "select",
            options: [
              { id: "default", label: "Standard", isDefault: true },
              { id: "fast", label: "Fast" },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const claudeProvider: ServerProvider = {
  ...codexProvider,
  instanceId: claudeId,
  driver: ProviderDriverKind.make("claudeAgent"),
  models: [
    {
      slug: "claude-opus-5",
      name: "Claude Opus 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "medium", label: "Medium" },
              { id: "max", label: "Max" },
            ],
          },
          { id: "fastMode", label: "Fast", type: "boolean" },
        ],
      },
    },
  ],
};

const entries = deriveProviderInstanceEntries([codexProvider, claudeProvider]);

const solUltra: ModelSelection = {
  instanceId: codexId,
  model: "gpt-6.1-sol",
  options: [
    { id: "reasoningEffort", value: "ultra" },
    { id: "serviceTier", value: "fast" },
  ],
};
const opus: ModelSelection = {
  instanceId: claudeId,
  model: "claude-opus-5",
  options: [{ id: "effort", value: "max" }],
};

const base: RunningModelStripInput = {
  phase: "ready",
  hasPendingApproval: false,
  hasPendingUserInput: false,
  requestedSelection: solUltra,
  nextSelection: opus,
  entries,
};

describe("deriveRunningModelState", () => {
  const idle = { phase: "ready", hasPendingApproval: false, hasPendingUserInput: false } as const;

  it("maps session phase and pending requests, approvals first", () => {
    expect(deriveRunningModelState(idle)).toBe("idle");
    expect(deriveRunningModelState({ ...idle, phase: "disconnected" })).toBe("idle");
    expect(deriveRunningModelState({ ...idle, phase: "connecting" })).toBe("connecting");
    expect(deriveRunningModelState({ ...idle, phase: "running" })).toBe("running");
    expect(deriveRunningModelState({ ...idle, phase: "running", hasPendingUserInput: true })).toBe(
      "awaiting-input",
    );
    expect(
      deriveRunningModelState({
        ...idle,
        phase: "running",
        hasPendingUserInput: true,
        hasPendingApproval: true,
      }),
    ).toBe("awaiting-approval");
  });

  it("reports an error only when nothing is running", () => {
    expect(deriveRunningModelState({ ...idle, sessionStatus: "error" })).toBe("error");
    expect(deriveRunningModelState({ ...idle, latestTurnState: "error" })).toBe("error");
    expect(deriveRunningModelState({ ...idle, phase: "running", sessionStatus: "error" })).toBe(
      "running",
    );
    expect(deriveRunningModelState({ ...idle, latestTurnState: "completed" })).toBe("idle");
  });
});

describe("resolveRunningModelTarget", () => {
  it("resolves display name, effort label and fast tier from the catalog", () => {
    expect(resolveRunningModelTarget(solUltra, entries)).toMatchObject({
      modelSlug: "gpt-6.1-sol",
      modelName: "GPT-6.1 Sol",
      effortId: "ultra",
      effortLabel: "Ultra",
      fastMode: true,
    });
  });

  it("reads boolean fast mode and leaves it off when unset", () => {
    expect(
      resolveRunningModelTarget(
        {
          ...opus,
          options: [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        },
        entries,
      ),
    ).toMatchObject({ effortLabel: "Max", fastMode: true });
    expect(resolveRunningModelTarget(opus, entries)?.fastMode).toBe(false);
  });

  it("falls back to the raw slug and option value for models missing from the catalog", () => {
    const custom: ModelSelection = {
      instanceId: ProviderInstanceId.make("gone"),
      model: "mystery-1",
      options: [{ id: "effort", value: "high" }],
    };
    expect(resolveRunningModelTarget(custom, entries)).toMatchObject({
      providerName: "gone",
      modelName: "mystery-1",
      effortLabel: "high",
      driverKind: null,
    });
  });

  it("returns null for the no-provider placeholder", () => {
    expect(resolveRunningModelTarget({ instanceId: codexId, model: "" }, entries)).toBeNull();
    expect(resolveRunningModelTarget(null, entries)).toBeNull();
  });
});

describe("deriveRunningModelStrip", () => {
  it("shows the next model while idle, even when the thread has an older selection", () => {
    const view = deriveRunningModelStrip(base);
    expect(view.state).toBe("idle");
    expect(view.basisLabel).toBe("次に使う");
    expect(view.target?.modelName).toBe("Claude Opus 5");
  });

  it("shows the thread's started-with selection, labelled 指定, while a turn is in flight", () => {
    const view = deriveRunningModelStrip({ ...base, phase: "running" });
    expect(view.stateLabel).toBe("実行中");
    expect(view.basisLabel).toBe("指定");
    expect(view.target?.modelName).toBe("GPT-6.1 Sol");
    expect(view.served).toBeNull();
    expect(view.mismatch).toBe(false);
  });

  it("falls back to the next selection when a draft has no started-with selection", () => {
    const view = deriveRunningModelStrip({
      ...base,
      phase: "connecting",
      requestedSelection: null,
    });
    expect(view.basisLabel).toBe("次に使う");
    expect(view.target?.modelName).toBe("Claude Opus 5");
  });

  it("flags a served model that differs from the requested one", () => {
    const view = deriveRunningModelStrip({
      ...base,
      phase: "running",
      servedModel: { model: "claude-opus-5" },
    });
    expect(view.mismatch).toBe(true);
    // Not in the requested provider's catalog, so the reported slug is shown as is.
    expect(view.served?.modelName).toBe("claude-opus-5");
  });

  it("does not flag a served model that matches, including through an alias", () => {
    expect(
      deriveRunningModelStrip({ ...base, phase: "running", servedModel: { model: "sol" } })
        .mismatch,
    ).toBe(false);
  });

  it("never pairs a served model with the 次に使う selection", () => {
    const view = deriveRunningModelStrip({ ...base, servedModel: { model: "claude-opus-5" } });
    expect(view.served).toBeNull();
    expect(view.mismatch).toBe(false);
  });

  it("turns delegated child runs into chips with their own status", () => {
    const threadId = ThreadId.make("child-1");
    const view = deriveRunningModelStrip({
      ...base,
      delegatedRuns: [
        { threadId, instanceId: codexId, model: "sol", effort: "Ultra", status: "running" },
        { threadId: ThreadId.make("child-2"), instanceId: claudeId, model: "x", status: "queued" },
      ],
    });
    expect(view.delegated).toMatchObject([
      {
        threadId,
        providerName: "Codex",
        modelName: "GPT-6.1 Sol",
        effortLabel: "Ultra",
        statusLabel: "実行中",
        tone: "info",
      },
      { modelName: "x", effortLabel: null, statusLabel: "待機中", tone: "neutral" },
    ]);
  });

  it("keeps finished and interrupted children available alongside active children", () => {
    const view = deriveRunningModelStrip({
      ...base,
      delegatedRuns: [
        { threadId: ThreadId.make("c1"), instanceId: codexId, model: "x", status: "awaiting" },
        { threadId: ThreadId.make("c2"), instanceId: codexId, model: "x", status: "interrupted" },
        { threadId: ThreadId.make("c3"), instanceId: codexId, model: "x", status: "completed" },
        { threadId: ThreadId.make("c4"), instanceId: codexId, model: "x", status: "error" },
      ],
    });
    expect(view.delegated.map((chip) => [chip.statusLabel, chip.tone])).toEqual([
      ["要対応", "warning"],
      ["中断", "neutral"],
      ["完了", "neutral"],
      ["エラー", "error"],
    ]);
  });

  it("retains the display reference through unrelated activity and usage updates", () => {
    const select = createRunningModelStripSelector();
    const first = select({ ...base, phase: "running", servedModel: { model: "sol" } });
    const sameValues = select({
      ...base,
      phase: "running",
      requestedSelection: { ...solUltra, options: [...solUltra.options!] },
      servedModel: { model: "sol" },
      delegatedRuns: [],
    });
    expect(sameValues).toBe(first);
    expect(select({ ...base, phase: "running", servedModel: { model: "other" } })).not.toBe(first);
  });
});

describe("deriveRunningSubagents", () => {
  const activity = (
    kind: string,
    payload: Record<string, unknown>,
  ): OrchestrationThreadActivity => ({
    id: EventId.make(kind),
    tone: "info",
    kind,
    summary: kind,
    payload: { agentKind: "agent", ...payload },
    turnId: null,
    createdAt: "2026-10-11T00:00:00.000Z",
  });
  const started = activity("task.started", {
    taskId: "native-1",
    title: "Done and copy",
    model: "sol and copy",
    status: "running",
  });
  const modelFor = (activities: ReadonlyArray<OrchestrationThreadActivity>) =>
    deriveAgentPanelModel({ agents: foldSubagentActivities(activities) });

  it("uses reported model names verbatim and ignores finished, idle or session-orphaned native agents", () => {
    const first = deriveRunningSubagents(modelFor([started]));
    expect(first).toEqual([
      { id: "native-1", title: "Done and copy", model: "sol and copy", status: "running" },
    ]);
    for (const status of ["completed", "failed", "cancelled", "interrupted", "idle"]) {
      expect(
        deriveRunningSubagents(
          modelFor([started, activity("task.updated", { taskId: "native-1", status })]),
        ),
      ).toEqual([]);
    }
    expect(
      deriveRunningSubagents(
        deriveAgentPanelModel({
          agents: foldSubagentActivities([started], { sessionLive: false }),
        }),
      ),
    ).toEqual([]);
  });

  it("keeps the reference during native progress/usage updates and changes it when model or status changes", () => {
    const first = deriveRunningSubagents(modelFor([started]));
    const progress = modelFor([
      started,
      activity("task.progress", {
        taskId: "native-1",
        summary: "new activity",
        usage: { totalTokens: 200 },
      }),
    ]);
    expect(deriveRunningSubagents(progress, first)).toBe(first);
    const changed = deriveRunningSubagents(
      modelFor([
        started,
        activity("task.updated", { taskId: "native-1", status: "waiting", model: "new-model" }),
      ]),
      first,
    );
    expect(changed).not.toBe(first);
    expect(changed[0]).toMatchObject({ status: "waiting", model: "new-model" });
    expect(deriveRunningModelStrip({ ...base, subagents: changed }).subagents).toBe(changed);
  });

  it("counts a starting workflow coordinator until members arrive, then counts only active members", () => {
    const coordinator = activity("task.started", {
      taskId: "workflow",
      taskType: "local_workflow",
      title: "Workflow",
      model: "coordinator-model",
      status: "running",
    });
    const starting = modelFor([coordinator]);
    expect(starting.liveCount).toBe(1);
    expect(deriveRunningSubagents(starting)).toMatchObject([
      { id: "workflow", model: "coordinator-model", status: "running" },
    ]);

    const member = activity("task.progress", {
      taskId: "workflow:member",
      parentAgentId: "workflow",
      title: "Member",
      model: "member-model",
      status: "running",
    });
    const withMember = modelFor([coordinator, member]);
    expect(withMember.liveCount).toBe(1);
    expect(deriveRunningSubagents(withMember)).toMatchObject([
      { id: "workflow:member", model: "member-model", status: "running" },
    ]);
    const settled = modelFor([
      coordinator,
      member,
      activity("task.updated", { taskId: "workflow:member", status: "completed" }),
    ]);
    expect(settled.liveCount).toBe(0);
    expect(deriveRunningSubagents(settled)).toEqual([]);
  });
});

describe("servedModelMismatch", () => {
  const requested = {
    driverKind: ProviderDriverKind.make("codex"),
    modelSlug: "gpt-6.1-sol",
    effortId: "ultra",
  };
  const models = codexProvider.models;

  it("compares models case-insensitively through the catalog", () => {
    expect(servedModelMismatch({ requested, served: { model: "GPT-6.1 Sol" }, models })).toBe(
      false,
    );
    expect(servedModelMismatch({ requested, served: { model: "gpt-6" }, models })).toBe(true);
  });

  it("only compares effort when the server reported one", () => {
    expect(servedModelMismatch({ requested, served: { model: "sol", effort: null }, models })).toBe(
      false,
    );
    expect(
      servedModelMismatch({ requested, served: { model: "sol", effort: "Ultra" }, models }),
    ).toBe(false);
    expect(
      servedModelMismatch({ requested, served: { model: "sol", effort: "high" }, models }),
    ).toBe(true);
  });
});
