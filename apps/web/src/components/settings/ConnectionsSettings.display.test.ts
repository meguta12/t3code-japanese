import { describe, expect, it } from "vite-plus/test";
import { buildConnectedClientDisplay } from "./ConnectionsSettings";

describe("buildConnectedClientDisplay", () => {
  it("translates device type before joining while preserving client metadata", () => {
    expect(
      buildConnectedClientDisplay(
        {
          deviceType: "desktop",
          label: "Done",
          os: "On",
          browser: "Thinking",
          ipAddress: "127.0.0.1",
        },
        "Fallback",
      ),
    ).toEqual({
      primaryLabel: "Done",
      deviceInfo: "デスクトップ · On · Thinking · 127.0.0.1",
    });
  });

  it("preserves the OS and browser fallback instead of translating the combined text", () => {
    expect(
      buildConnectedClientDisplay({ deviceType: "unknown", os: "On", browser: "Done" }, "Off"),
    ).toEqual({
      primaryLabel: "On · Done",
      deviceInfo: "On · Done",
    });
    expect(buildConnectedClientDisplay({ deviceType: "unknown" }, "Off")).toEqual({
      primaryLabel: "Off",
      deviceInfo: "",
    });
  });

  it.each([
    ["mobile", "モバイル"],
    ["tablet", "タブレット"],
    ["bot", "ボット"],
  ] as const)("translates the fixed %s device type", (deviceType, label) => {
    expect(buildConnectedClientDisplay({ deviceType }, "subject").deviceInfo).toBe(label);
  });
});
