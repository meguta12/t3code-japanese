// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Calendar } from "./calendar";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Japanese calendar", () => {
  it("keeps month and weekday labels Japanese while navigating months", async () => {
    await act(async () => {
      root.render(<Calendar defaultMonth={new Date(2026, 5, 4)} />);
    });

    expect(container.textContent).toContain("2026年6月");
    expect(Array.from(container.querySelectorAll("th"), (day) => day.textContent)).toEqual([
      "日",
      "月",
      "火",
      "水",
      "木",
      "金",
      "土",
    ]);
    const nextMonth = container.querySelector<HTMLButtonElement>('button[aria-label="次の月へ"]');
    expect(nextMonth).not.toBeNull();
    await act(async () => nextMonth?.click());
    expect(container.textContent).toContain("2026年7月");
    expect(container.textContent).not.toMatch(/June|July|Mon|Tue/);
  });

  it("shows Japanese month choices when using the dropdown caption", async () => {
    await act(async () => {
      root.render(<Calendar defaultMonth={new Date(2026, 5, 4)} captionLayout="dropdown" />);
    });

    const monthSelect = container.querySelector<HTMLSelectElement>("select.rdp-months_dropdown");
    expect(monthSelect).not.toBeNull();
    expect(Array.from(monthSelect?.options ?? [], (option) => option.text)).toEqual([
      "1月",
      "2月",
      "3月",
      "4月",
      "5月",
      "6月",
      "7月",
      "8月",
      "9月",
      "10月",
      "11月",
      "12月",
    ]);
    await act(async () => {
      if (monthSelect) {
        monthSelect.value = "6";
        monthSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(container.textContent).toContain("7月");
    expect(monthSelect?.value).toBe("6");
  });
});
