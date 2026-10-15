import { describe, expect, it } from "vite-plus/test";
import { localizedToolGroupSummary } from "./localizedWorkLog";
import { liveWorkEntryLabel, workEntryDisplayLabel } from "./MessagesTimeline.logic";
import type { WorkLogEntry } from "../../session-logic";

const entry = (data: Partial<WorkLogEntry>): WorkLogEntry => ({
  id: "entry",
  createdAt: "2026-10-11T00:00:00Z",
  label: "Tool",
  tone: "tool",
  ...data,
});

describe("Japanese work log presentation", () => {
  it("summarizes mixed actions and counts an edited path once", () => {
    const entries = [
      entry({ itemType: "command_execution", command: "Done --filename 'Read 1 file'" }),
      entry({ itemType: "file_change", changedFiles: ["Done"] }),
      entry({ itemType: "file_change", changedFiles: ["Done"] }),
    ];
    expect(localizedToolGroupSummary(entries)).toBe(
      "1件のコマンドを実行しました、1個のファイルを変更しました",
    );
  });

  it("preserves integration names that resemble labels and separators", () => {
    expect(
      localizedToolGroupSummary([
        entry({ toolSource: { key: "first", name: "Done", kind: "integration" } }),
        entry({
          toolSource: { key: "second", name: "Fix login and signup flow", kind: "integration" },
        }),
      ]),
    ).toBe("Done、Fix login and signup flowを使用しました");
  });

  it("keeps commands, paths and tool detail verbatim", () => {
    expect(workEntryDisplayLabel(entry({ command: "Done" }), undefined)).toBe("Done");
    expect(workEntryDisplayLabel(entry({ detail: "Fix login and signup flow" }), undefined)).toBe(
      "Fix login and signup flow",
    );
    expect(workEntryDisplayLabel(entry({ changedFiles: ["Done"] }), undefined)).toBe("Done");
  });

  it("inserts a command name after translating the running template", () => {
    expect(liveWorkEntryLabel(entry({ command: "Done --help" }), undefined, true)).toBe(
      "Doneを実行中",
    );
  });
});
