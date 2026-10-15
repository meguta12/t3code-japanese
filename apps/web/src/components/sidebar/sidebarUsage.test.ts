import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { hasSidebarQuotaWindows, isSidebarQuotaRow, sidebarQuotaWindows } from "./sidebarUsage";

const now = Date.parse("2026-10-04T00:00:00Z");
const session: ServerProviderUsageWindow = {
  id: "primary",
  kind: "session",
  label: "Session",
  usedPercent: 23,
  windowDurationMins: 300,
  resetsAt: "2026-10-04T04:00:00Z",
};
const weekly: ServerProviderUsageWindow = {
  id: "secondary",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 94,
};

describe("sidebar quota windows", () => {
  it("shows remaining allowance, including an exhausted window", () => {
    const result = sidebarQuotaWindows([session, weekly], now);
    expect(result.map(({ label, remaining }) => ({ label, remaining }))).toEqual([
      { label: "5H", remaining: 77 },
      { label: "Week", remaining: 6 },
    ]);
    expect(sidebarQuotaWindows([{ ...session, usedPercent: 100 }], now)[0]?.remaining).toBe(0);
    expect(sidebarQuotaWindows([{ ...session, usedPercent: 0 }], now)[0]?.remaining).toBe(100);
  });

  it("keeps missing and monthly windows unknown instead of claiming full quota", () => {
    expect(sidebarQuotaWindows([], now).map((window) => window.remaining)).toEqual([null, null]);
    expect(
      sidebarQuotaWindows([{ ...session, kind: "monthly", windowDurationMins: 43200 }], now)[0]
        ?.remaining,
    ).toBeNull();
    expect(
      sidebarQuotaWindows([{ ...session, windowDurationMins: 120 }], now)[0]?.remaining,
    ).toBeNull();
  });

  it("waits for a provider update after reset rather than inventing a new balance", () => {
    const result = sidebarQuotaWindows([{ ...session, resetsAt: "2026-10-03T23:59:00Z" }], now);
    expect(result[0]?.remaining).toBeNull();
    expect(result[0]?.expired).toBe(true);
  });

  it("prefers the account weekly allowance over a model-specific window", () => {
    const model = { ...weekly, id: "seven_day_sonnet", usedPercent: 10 };
    expect(sidebarQuotaWindows([model, { ...weekly, id: "seven_day" }], now)[1]?.remaining).toBe(6);
    expect(sidebarQuotaWindows([model], now)[1]?.remaining).toBeNull();
  });

  it("accepts a five-hour provider window whose duration was omitted", () => {
    expect(
      sidebarQuotaWindows([{ ...session, windowDurationMins: undefined }], now)[0]?.remaining,
    ).toBe(77);
  });

  it("shows the tightest pool when a provider reports one per model group", () => {
    const groups: ServerProviderUsageWindow[] = [
      { ...session, id: "3p-5h", usedPercent: 10 },
      { ...session, id: "gemini-5h", usedPercent: 40 },
      { ...weekly, id: "3p-weekly", usedPercent: 50 },
      { ...weekly, id: "gemini-weekly", usedPercent: 25 },
    ];
    expect(sidebarQuotaWindows(groups, now).map((window) => window.remaining)).toEqual([60, 50]);
  });
});

describe("sidebar quota rows", () => {
  const limits = (windows: ServerProviderUsageWindow[], unavailable?: "unsupported") => ({
    checkedAt: "2026-10-04T00:00:00Z",
    windows,
    ...(unavailable ? { unavailable: { reason: unavailable } } : {}),
  });

  it("lists any provider that reports a 5H or Week window, whatever its driver id", () => {
    for (const driver of ["codex", "claudeAgent", "antigravity", "commandcode"]) {
      expect(isSidebarQuotaRow({ driver, limits: limits([session]) })).toBe(true);
    }
    expect(isSidebarQuotaRow({ driver: "antigravity", limits: limits([weekly]) })).toBe(true);
    expect(hasSidebarQuotaWindows([{ ...weekly, id: "seven_day_opus" }])).toBe(false);
  });

  it("keeps Codex and Claude listed while their first read is pending", () => {
    expect(isSidebarQuotaRow({ driver: "claudeAgent", limits: limits([]) })).toBe(true);
    expect(isSidebarQuotaRow({ driver: "codex", limits: undefined })).toBe(true);
  });

  it("leaves out accounts and providers with nothing to draw", () => {
    const monthly = { ...session, kind: "monthly", windowDurationMins: 43200 } as const;
    expect(isSidebarQuotaRow({ driver: "cursor", limits: limits([monthly]) })).toBe(false);
    expect(isSidebarQuotaRow({ driver: "antigravity", limits: limits([]) })).toBe(false);
    expect(isSidebarQuotaRow({ driver: "claudeAgent", limits: limits([], "unsupported") })).toBe(
      false,
    );
  });
});
