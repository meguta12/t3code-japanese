import { describe, expect, it } from "vite-plus/test";
import { searchSettings } from "./settingsSearch";

describe("Japanese settings search", () => {
  it("finds the same setting in Japanese and English", () => {
    expect(searchSettings("文字サイズ").some((item) => item.id.includes("font"))).toBe(true);
    expect(
      searchSettings("バックグラウンド").some((item) => item.id === "background-activity"),
    ).toBe(true);
    expect(
      searchSettings("background activity").some((item) => item.id === "background-activity"),
    ).toBe(true);
  });
});
