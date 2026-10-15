import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatDayAwareTimestamp,
  formatElapsedDurationLabel,
  formatExpiresInLabel,
  formatRelativeTime,
  formatRelativeTimeLabel,
  formatShortTimestamp,
  formatUpcomingTimestamp,
  getRelativeTimeState,
  resolveTimestampLocale,
} from "./timestampFormat";

describe("resolveTimestampLocale", () => {
  it("defers to the runtime default when the host reports no locale", () => {
    expect(resolveTimestampLocale(null)).toBeUndefined();
    expect(resolveTimestampLocale(undefined)).toBeUndefined();
    expect(resolveTimestampLocale("   ")).toBeUndefined();
  });

  it("uses a BCP-47 tag reported by the host", () => {
    expect(resolveTimestampLocale("en-GB")).toBe("en-GB");
  });

  it("defers to the runtime default rather than throwing on an unusable tag", () => {
    // The desktop bridge normalizes POSIX identifiers before reporting them, so
    // anything Intl still rejects here falls back instead of breaking every
    // timestamp in the UI.
    expect(resolveTimestampLocale("not a locale")).toBeUndefined();
    expect(resolveTimestampLocale("en_GB")).toBeUndefined();
  });
});

describe("formatShortTimestamp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    ["en-GB", "15:44"],
    ["en-US", "3:44 PM"],
  ])("honors %s and the explicit hour-cycle settings", async (locale, localTime) => {
    vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => locale } });
    vi.resetModules();
    const { formatShortTimestamp: format } = await import("./timestampFormat");
    const date = new Date(2026, 3, 7, 15, 44).toISOString();
    // ICU can separate the day period with a narrow no-break space.
    expect(format(date, "locale").replace(/[  ]/g, " ")).toBe(localTime);
    expect(format(date, "12-hour").replace(/[  ]/g, " ")).toMatch(/^3:44 [ap]m$/i);
    expect(format(date, "24-hour")).toBe("15:44");
  });
});

describe("resolveWeekStartsOn", () => {
  it.each([
    ["en-US", 0],
    ["en-GB", 1],
    ["pl-PL", 1],
    ["ar-EG", 6],
  ])("starts the %s week on weekday %i", async (locale, weekday) => {
    const { resolveWeekStartsOn } = await import("./timestampFormat");
    expect(resolveWeekStartsOn(locale)).toBe(weekday);
  });

  it("leaves the default to the caller for a malformed locale", async () => {
    const { resolveWeekStartsOn } = await import("./timestampFormat");
    expect(resolveWeekStartsOn("not a locale")).toBeUndefined();
  });

  it("follows the locale the desktop host reports", async () => {
    vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => "en-GB" } });
    vi.resetModules();
    const { weekStartsOn } = await import("./timestampFormat");
    expect(weekStartsOn).toBe(1);
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe("formatChatTimestampTooltip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each(["en-US", "de-DE", "it-IT"])(
    "keeps the Japanese date label in a %s runtime",
    async (locale) => {
      const DateTimeFormat = Intl.DateTimeFormat;
      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
        return new DateTimeFormat(locales ?? locale, options);
      });
      vi.resetModules();
      const { formatChatTimestampTooltip: format } = await import("./timestampFormat");
      const date = new Date(2026, 5, 4, 14, 4).toISOString();

      expect(format(date, "24-hour")).toBe("2026年6月4日 14:04");
    },
  );
});

describe("formatExpiresInLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a Japanese expiry label at and after the instant", () => {
    expect(formatExpiresInLabel("2026-04-07T11:59:00.000Z")).toBe("期限切れ");
    expect(formatExpiresInLabel("2026-04-07T12:00:00.000Z")).toBe("期限切れ");
    expect(formatExpiresInLabel("2026-04-07T12:00:04.000Z")).toBe("まもなく期限切れ");
  });

  it("uses sub-minute second count", () => {
    expect(formatExpiresInLabel("2026-04-07T12:00:45.000Z")).toBe("あと45秒で期限切れ");
  });

  it("uses minutes and seconds under one hour", () => {
    expect(formatExpiresInLabel("2026-04-07T12:04:12.000Z")).toBe("あと4分12秒で期限切れ");
    expect(formatExpiresInLabel("2026-04-07T12:15:00.000Z")).toBe("あと15分で期限切れ");
  });

  it("uses hours with minute and second remainder", () => {
    expect(formatExpiresInLabel("2026-04-07T14:02:03.000Z")).toBe("あと2時間2分3秒で期限切れ");
    expect(formatExpiresInLabel("2026-04-07T18:00:00.000Z")).toBe("あと6時間で期限切れ");
  });

  it("keeps days and sub-day remainders in Japanese", () => {
    expect(formatExpiresInLabel("2026-04-09T12:00:00.000Z")).toBe("あと2日で期限切れ");
    expect(formatExpiresInLabel("2026-04-09T14:02:03.000Z")).toBe("あと2日2時間2分3秒で期限切れ");
  });
});

describe("formatDayAwareTimestamp", () => {
  // Instants are built with the local-time Date constructor so the
  // calendar-day boundaries hold in any test timezone or locale.
  const iso = (y: number, monthIndex: number, d: number, h: number, mi: number) =>
    new Date(y, monthIndex, d, h, mi).toISOString();
  const now = new Date(2026, 7, 14, 12, 0).getTime();
  const time = (isoDate: string) => formatShortTimestamp(isoDate, "12-hour");

  it("shows time only for today", () => {
    const messageAt = iso(2026, 7, 14, 9, 30);
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(time(messageAt));
  });

  it("labels the previous calendar day as yesterday even when under 24h old", () => {
    const messageAt = iso(2026, 7, 13, 23, 30);
    const justPastMidnight = new Date(2026, 7, 14, 0, 30).getTime();
    expect(formatDayAwareTimestamp(messageAt, "12-hour", justPastMidnight)).toBe(
      `昨日 ${time(messageAt)}`,
    );
  });

  it("prefixes older same-year messages with the numeric date", () => {
    const messageAt = iso(2026, 7, 12, 12, 34);
    const datePart = new Intl.DateTimeFormat("ja-JP", {
      month: "numeric",
      day: "numeric",
    }).format(new Date(messageAt));
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(
      `${datePart} ${time(messageAt)}`,
    );
  });

  it("includes the year once the calendar year differs", () => {
    const messageAt = iso(2025, 11, 31, 18, 0);
    const datePart = new Intl.DateTimeFormat("ja-JP", {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    }).format(new Date(messageAt));
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(
      `${datePart} ${time(messageAt)}`,
    );
  });

  it("keeps dates in Japanese while preserving the host clock preference", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { getSystemLocale: () => "en-GB" },
    });
    vi.resetModules();

    const { formatDayAwareTimestamp: formatWithHostLocale } = await import("./timestampFormat");
    const messageAt = iso(2026, 7, 12, 15, 44);

    expect(formatWithHostLocale(messageAt, "locale", now)).toBe("8/12 15:44");

    vi.unstubAllGlobals();
  });

  it("returns an empty string for invalid input", () => {
    expect(formatDayAwareTimestamp("not-a-date", "12-hour", now)).toBe("");
  });
});

describe("formatUpcomingTimestamp", () => {
  const now = new Date(2026, 7, 14, 23, 30).getTime();

  it("uses tomorrow at the local calendar boundary", () => {
    const resetAt = new Date(2026, 7, 15, 0, 30).toISOString();
    expect(formatUpcomingTimestamp(resetAt, "24-hour", now)).toBe(
      `明日 ${formatShortTimestamp(resetAt, "24-hour")}`,
    );
  });

  it("uses Japanese date order for later days and years", () => {
    const laterDay = new Date(2026, 7, 16, 9).toISOString();
    const nextYear = new Date(2027, 0, 1, 9).toISOString();
    expect(formatUpcomingTimestamp(laterDay, "24-hour", now)).toBe(
      `8/16 ${formatShortTimestamp(laterDay, "24-hour")}`,
    );
    expect(formatUpcomingTimestamp(nextYear, "24-hour", now)).toBe(
      `2027/1/1 ${formatShortTimestamp(nextYear, "24-hour")}`,
    );
    expect(formatUpcomingTimestamp("not-a-date", "24-hour", now)).toBe("");
  });
});

describe("invalid timestamp inputs", () => {
  it("returns an empty short timestamp instead of throwing", () => {
    expect(formatShortTimestamp("not-a-date", "12-hour")).toBe("");
  });

  it("returns an empty relative time label instead of a NaN label", () => {
    expect(formatRelativeTime("not-a-date")).toBeNull();
    expect(formatRelativeTimeLabel("not-a-date")).toBe("");
  });

  it("distinguishes missing and invalid relative time state", () => {
    expect(getRelativeTimeState(null)).toEqual({ status: "missing" });
    expect(getRelativeTimeState("not-a-date")).toEqual({ status: "invalid" });
  });

  it("returns an empty elapsed duration instead of a NaN label", () => {
    expect(formatElapsedDurationLabel("not-a-date")).toBe("");
  });

  it("returns an empty expires-in label instead of a NaN label", () => {
    expect(formatExpiresInLabel("not-a-date")).toBe("");
  });
});

describe("getRelativeTimeState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns relative parts for valid timestamps", () => {
    expect(getRelativeTimeState("2026-04-07T11:45:00.000Z")).toEqual({
      status: "relative",
      value: "15分",
      suffix: "前",
    });
  });

  it.each([
    ["2026-04-07T12:01:00.000Z", "たった今"],
    ["2026-04-07T11:59:01.000Z", "たった今"],
    ["2026-04-07T11:59:00.000Z", "1分前"],
    ["2026-04-07T11:00:00.000Z", "1時間前"],
    ["2026-04-06T12:00:00.000Z", "1日前"],
  ])("formats %s in Japanese", (instant, expected) => {
    expect(formatRelativeTimeLabel(instant)).toBe(expected);
  });
});

describe("formatElapsedDurationLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns just now when the instant is current or in the future", () => {
    expect(formatElapsedDurationLabel("2026-04-07T12:00:00.000Z")).toBe("たった今");
    expect(formatElapsedDurationLabel("2026-04-07T12:01:00.000Z")).toBe("たった今");
  });

  it("formats seconds, minutes, hours, and days", () => {
    expect(formatElapsedDurationLabel("2026-04-07T11:59:45.000Z")).toBe("15秒");
    expect(formatElapsedDurationLabel("2026-04-07T11:45:00.000Z")).toBe("15分");
    expect(formatElapsedDurationLabel("2026-04-07T06:00:00.000Z")).toBe("6時間");
    expect(formatElapsedDurationLabel("2026-04-03T12:00:00.000Z")).toBe("4日");
  });
});
