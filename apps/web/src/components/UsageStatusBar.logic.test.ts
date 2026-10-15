import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, type ServerProvider } from "@t3tools/contracts";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import {
  buildStatusBarChips,
  decodeThreadKey,
  deriveThreadContextSummary,
  encodeThreadKey,
  formatContextLine,
  formatTodayTokens,
  formatTotalLine,
  statusBarNeedsUsageScan,
  threadContextSummaryEqual,
  todayTokensByProvider,
  type QuotaRow,
  type StatusBarProviderConfig,
} from "./UsageStatusBar.logic";

function summaryOf(payload: unknown) {
  const activity: OrchestrationThreadActivity = {
    id: EventId.make("status-bar-test"),
    kind: "context-window.updated",
    tone: "info",
    summary: "Context window updated",
    payload,
    turnId: null,
    createdAt: "2026-10-06T00:00:00.000Z",
  };
  return deriveThreadContextSummary(deriveLatestContextWindowSnapshot([activity]));
}

function provider(driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: driver,
    driver,
    enabled: true,
    installed: true,
    ...overrides,
  } as unknown as ServerProvider;
}

describe("status bar thread context", () => {
  it("formats current context with window and percent next to the cumulative total", () => {
    const summary = summaryOf({
      usedTokens: 123_000,
      maxTokens: 1_000_000,
      totalProcessedTokens: 3_400_000,
    });
    expect(formatContextLine(summary)).toBe("コンテキスト 12.3万 / 100万 (12%)");
    expect(formatTotalLine(summary)).toBe("累計 340万");
  });

  it("omits the window and total when the provider does not report them", () => {
    const summary = summaryOf({ usedTokens: 4_200 });
    expect(formatContextLine(summary)).toBe("コンテキスト 4,200");
    expect(formatTotalLine(summary)).toBeNull();
  });

  it("has nothing to show without context data", () => {
    expect(summaryOf({})).toBeNull();
    expect(formatContextLine(null)).toBeNull();
    expect(formatTotalLine(null)).toBeNull();
  });

  it("treats unchanged figures as equal so the bar does not re-render", () => {
    const payload = { usedTokens: 1_000, maxTokens: 10_000, totalProcessedTokens: 5_000 };
    expect(threadContextSummaryEqual(summaryOf(payload), summaryOf(payload))).toBe(true);
    expect(
      threadContextSummaryEqual(summaryOf(payload), summaryOf({ ...payload, usedTokens: 1_001 })),
    ).toBe(false);
    expect(threadContextSummaryEqual(null, null)).toBe(true);
    expect(threadContextSummaryEqual(null, summaryOf(payload))).toBe(false);
  });

  it("round-trips thread keys and rejects malformed ones", () => {
    expect(decodeThreadKey(encodeThreadKey("env/1", "thread:2"))).toEqual({
      environmentId: "env/1",
      threadId: "thread:2",
    });
    expect(decodeThreadKey("not json")).toBeNull();
    expect(decodeThreadKey('["only-one"]')).toBeNull();
  });
});

describe("status bar today's tokens", () => {
  const daily = [
    { day: "2026-10-05", byProvider: new Map([["opencode", { costUsd: 0, totalTokens: 999 }]]) },
    {
      day: "2026-10-06",
      byProvider: new Map([
        ["opencode", { costUsd: 0, totalTokens: 52_000 }],
        ["codex", { costUsd: 0, totalTokens: 7 }],
      ]),
    },
  ] as unknown as readonly DailyTotals[];

  it("sums only the requested day per provider", () => {
    const totals = todayTokensByProvider(daily, "2026-10-06");
    expect(totals.get("opencode")).toBe(52_000);
    expect(totals.get("codex")).toBe(7);
    expect(totals.get("antigravity")).toBeUndefined();
  });

  it("formats unknown, small and large counts", () => {
    expect(formatTodayTokens(null)).toBe("今日 —");
    expect(formatTodayTokens(0)).toBe("今日 0tok");
    expect(formatTodayTokens(3_200)).toBe("今日 3,200tok");
    expect(formatTodayTokens(52_000)).toBe("今日 5.2万tok");
  });
});

describe("status bar chips", () => {
  const now = Date.parse("2026-10-06T00:00:00Z");
  const codexRow: QuotaRow = {
    key: "codex:a",
    driver: "codex",
    displayName: "Codex",
    limits: {
      checkedAt: "2026-10-06T00:00:00Z",
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 40,
          windowDurationMins: 300,
        },
        { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 10 },
      ],
    } as unknown as QuotaRow["limits"],
  };
  const providers = [
    provider("codex"),
    provider("claudeAgent"),
    provider("opencode"),
    provider("antigravity"),
    provider("commandcode"),
    provider("cursor"),
  ];
  const today = new Map([
    ["opencode" as const, 52_000],
    ["commandcode" as const, 7_000],
  ]);

  it("gives quota providers 5H/Week and the rest today's tokens, in config order", () => {
    const chips = buildStatusBarChips({
      providers,
      quotaRows: [codexRow],
      todayTokens: today,
      now,
    });
    expect(chips.map((chip) => [chip.driver, chip.kind])).toEqual([
      ["codex", "quota"],
      ["claudeAgent", "quota"],
      ["opencode", "tokens"],
      ["antigravity", "tokens"],
      ["commandcode", "tokens"],
    ]);
    const [codex, claude, opencode, antigravity, commandcode] = chips;
    expect(codex?.kind === "quota" && codex.quotas.map((q) => q.remaining)).toEqual([60, 90]);
    // Claude has no reported account yet: the chip stays, with unknown quotas.
    expect(claude?.kind === "quota" && claude.quotas.map((q) => q.remaining)).toEqual([null, null]);
    expect(opencode?.kind === "tokens" && opencode.todayTokens).toBe(52_000);
    expect(antigravity?.kind === "tokens" && antigravity.todayTokens).toBe(0);
    expect(commandcode?.kind === "tokens" && commandcode.todayTokens).toBe(7_000);
  });

  it("swaps Antigravity and Command Code to 5H/Week once they report windows", () => {
    const reporting = (driver: string, usedPercent: number): QuotaRow => ({
      key: `env:${driver}`,
      driver,
      displayName: null,
      limits: {
        checkedAt: "2026-10-06T00:00:00Z",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent,
            windowDurationMins: 300,
          },
          { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 25 },
        ],
      } as unknown as QuotaRow["limits"],
    });
    const quotaRows = [reporting("antigravity", 10), reporting("commandcode", 40)];
    const chips = buildStatusBarChips({ providers, quotaRows, todayTokens: today, now });
    const byDriver = new Map(chips.map((chip) => [chip.driver, chip]));
    const antigravity = byDriver.get("antigravity");
    const commandcode = byDriver.get("commandcode");
    expect(antigravity?.kind === "quota" && antigravity.quotas.map((q) => q.remaining)).toEqual([
      90, 75,
    ]);
    expect(commandcode?.kind === "quota" && commandcode.quotas.map((q) => q.remaining)).toEqual([
      60, 75,
    ]);
    // The usage scan is still needed for OpenCode, but no longer for these two.
    expect(statusBarNeedsUsageScan([provider("antigravity"), provider("commandcode")])).toBe(true);
    expect(
      statusBarNeedsUsageScan(
        [provider("antigravity"), provider("commandcode")],
        undefined,
        quotaRows,
      ),
    ).toBe(false);
  });

  it("keeps today's tokens for them while their limits are unavailable", () => {
    const unavailable: QuotaRow = {
      key: "env:commandcode",
      driver: "commandcode",
      displayName: null,
      limits: {
        checkedAt: "2026-10-06T00:00:00Z",
        windows: [],
        unavailable: { reason: "unsupported" },
      } as unknown as QuotaRow["limits"],
    };
    const chips = buildStatusBarChips({
      providers,
      quotaRows: [unavailable],
      todayTokens: today,
      now,
    });
    const commandcode = chips.find((chip) => chip.driver === "commandcode");
    expect(commandcode?.kind === "tokens" && commandcode.todayTokens).toBe(7_000);
  });

  it("leaves tokens unknown until the usage scan answers", () => {
    const chips = buildStatusBarChips({ providers, quotaRows: [], todayTokens: null, now });
    const opencode = chips.find((chip) => chip.driver === "opencode");
    expect(opencode?.kind === "tokens" && opencode.todayTokens).toBeNull();
  });

  it("hides providers that are disabled, not installed, or not connected", () => {
    const chips = buildStatusBarChips({
      providers: [
        provider("codex", { enabled: false }),
        provider("opencode", { installed: false }),
        provider("antigravity", { availability: "unavailable" }),
      ],
      quotaRows: [codexRow],
      todayTokens: today,
      now,
    });
    expect(chips).toEqual([]);
  });

  it("names accounts only when one provider has several", () => {
    const second: QuotaRow = { ...codexRow, key: "codex:b", displayName: "Codex Work" };
    const chips = buildStatusBarChips({
      providers,
      quotaRows: [codexRow, second],
      todayTokens: today,
      now,
    });
    const codexChips = chips.filter((chip) => chip.driver === "codex");
    expect(codexChips.map((chip) => chip.kind === "quota" && chip.accountName)).toEqual([
      "Codex",
      "Codex Work",
    ]);
  });

  it("adds a provider with one config entry", () => {
    const config: readonly StatusBarProviderConfig[] = [
      { driver: "commandCode", usageKind: null, label: "Command Code", quota: false },
    ];
    const chips = buildStatusBarChips({
      providers: [provider("commandCode")],
      quotaRows: [],
      todayTokens: today,
      now,
      config,
    });
    expect(chips.map((chip) => chip.label)).toEqual(["Command Code"]);
    expect(statusBarNeedsUsageScan([provider("commandCode")], config)).toBe(false);
    expect(statusBarNeedsUsageScan([provider("opencode")])).toBe(true);
    expect(statusBarNeedsUsageScan([provider("codex")])).toBe(false);
  });
});
