import { describe, expect, it } from "vite-plus/test";
import { formatUsageDuration, formatUsageResetsIn } from "./usageLocale";

describe("usage display localization", () => {
  it("formats numeric durations without changing shared source values", () => {
    expect(formatUsageDuration(-1000)).toBe("0分");
    expect(formatUsageDuration(13 * 60_000)).toBe("13分");
    expect(formatUsageDuration(2 * 3_600_000 + 13 * 60_000)).toBe("2時間 13分");
    expect(formatUsageDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3日 4時間");
  });

  it("keeps a provider window unchanged while localizing reset text", () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    const window = {
      id: "weekly",
      kind: "weekly" as const,
      label: "Done",
      usedPercent: 10,
      resetsAt: "2026-10-11T02:13:00Z",
    };
    expect(formatUsageResetsIn(window, now)).toBe("リセットまで2時間 13分");
    expect(formatUsageResetsIn(window, now + 86_400_000)).toBe("今リセット");
    expect(formatUsageResetsIn({ ...window, resetsAt: undefined }, now)).toBeNull();
    expect(window.label).toBe("Done");
    expect(window.resetsAt).toBe("2026-10-11T02:13:00Z");
  });
});
