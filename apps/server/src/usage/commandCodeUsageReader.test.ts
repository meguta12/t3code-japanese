// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - writes transcript fixtures to a temp directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { parseCommandCodeUsageLine, readCommandCodeUsage } from "./commandCodeUsageReader.ts";

const line = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "message",
    id: "m1",
    timestamp: "2026-10-02T07:06:18.232Z",
    model: "xiaomi/mimo-v2.6-flash",
    usage: {
      inputTokens: 25536,
      outputTokens: 33,
      cacheReadTokens: 4096,
      cacheWriteTokens: 0,
      costUsd: 0.003,
    },
    ...overrides,
  });

describe("parseCommandCodeUsageLine", () => {
  it("splits cached tokens out of the input count and keeps the CLI's own cost", () => {
    expect(parseCommandCodeUsageLine(line(), "s1", 0)).toEqual({
      provider: "commandcode",
      sessionId: "s1",
      timestampMs: Date.parse("2026-10-02T07:06:18.232Z"),
      model: "xiaomi/mimo-v2.6-flash",
      totals: {
        uncachedInputTokens: 21440,
        cachedInputTokens: 4096,
        cacheCreationTokens: 0,
        outputTokens: 33,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.003,
      fast: false,
      dedupeKey: "commandcode:s1:m1",
    });
  });

  it("ignores entries without usage, without a timestamp, or with all-zero counts", () => {
    expect(parseCommandCodeUsageLine(JSON.stringify({ type: "message" }), "s", 0)).toBeNull();
    expect(parseCommandCodeUsageLine(line({ timestamp: "nope" }), "s", 0)).toBeNull();
    expect(
      parseCommandCodeUsageLine(
        line({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }),
        "s",
        0,
      ),
    ).toBeNull();
    expect(parseCommandCodeUsageLine('{ not json "usage"', "s", 0)).toBeNull();
  });
});

describe("readCommandCodeUsage", () => {
  it("reads project transcripts inside the window and reports a missing root", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "commandcode-usage-"));
    const project = NodePath.join(root, "-tmp-project");
    await NodeFSP.mkdir(project);
    await NodeFSP.writeFile(
      NodePath.join(project, "session-1.jsonl"),
      [line(), line({ id: "old", timestamp: "2020-01-01T00:00:00.000Z" }), "garbage"].join("\n"),
    );
    const result = await readCommandCodeUsage(root, Date.parse("2026-01-01T00:00:00.000Z"));
    expect(result.error).toBe(false);
    expect(result.files.map((file) => file.records.map((record) => record.dedupeKey))).toEqual([
      ["commandcode:session-1:m1"],
    ]);
    const missing = await readCommandCodeUsage(NodePath.join(root, "absent"), 0);
    expect(missing).toMatchObject({ missing: true, error: false });
  });
});
