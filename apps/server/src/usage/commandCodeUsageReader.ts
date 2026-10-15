// Command Code transcripts are plain JSONL files walked with Node fs.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import type { UsageRecord } from "./usageTranscripts.ts";

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Parses one transcript line. Assistant entries carry
 * `{ usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }, model }`.
 * `inputTokens` includes cached tokens (cache reads never exceed it in local history), so
 * uncached input is derived by subtraction. `costUsd` is the CLI's own price and wins over
 * the rate table.
 */
export function parseCommandCodeUsageLine(
  line: string,
  sessionId: string,
  index: number,
): UsageRecord | null {
  if (!line.includes('"usage"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const entry = parsed as Record<string, unknown>;
  const usage = entry.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const counts = usage as Record<string, unknown>;
  const input = tokens(counts.inputTokens);
  const cacheRead = tokens(counts.cacheReadTokens);
  const cacheWrite = tokens(counts.cacheWriteTokens);
  const outputTokens = tokens(counts.outputTokens);
  if (input + cacheRead + cacheWrite + outputTokens === 0) return null;
  const timestampMs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(timestampMs)) return null;
  const cost = counts.costUsd;
  return {
    provider: "commandcode",
    sessionId,
    timestampMs,
    model:
      typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : "commandcode",
    totals: {
      uncachedInputTokens: Math.max(0, input - cacheRead - cacheWrite),
      cachedInputTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      outputTokens,
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    fast: false,
    dedupeKey: `commandcode:${sessionId}:${typeof entry.id === "string" ? entry.id : index}`,
  };
}

/** Reads `<root>/<project>/<session>.jsonl`, skipping files untouched since `sinceMs`. */
export async function readCommandCodeUsage(root: string, sinceMs: number) {
  const files: Array<{ path: string; records: UsageRecord[] }> = [];
  let error = false;
  let projects;
  try {
    projects = await NodeFSP.readdir(root, { withFileTypes: true });
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
    return { files, missing, error: !missing };
  }
  let read = 0;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = NodePath.join(root, project.name);
    let entries;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch {
      error = true;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = NodePath.join(directory, entry.name);
      try {
        if ((await NodeFSP.stat(path)).mtimeMs < sinceMs) continue;
        const sessionId = entry.name.slice(0, -".jsonl".length);
        const records: UsageRecord[] = [];
        for (const [index, line] of (await NodeFSP.readFile(path, "utf8")).split("\n").entries()) {
          const record = parseCommandCodeUsageLine(line, sessionId, index);
          if (record && record.timestampMs >= sinceMs) records.push(record);
        }
        files.push({ path, records });
      } catch {
        error = true;
      }
      if (++read % 64 === 0) await NodeTimersPromises.setImmediate();
    }
  }
  return { files, missing: false, error };
}
