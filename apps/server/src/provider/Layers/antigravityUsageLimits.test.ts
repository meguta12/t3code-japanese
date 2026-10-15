import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { antigravityUsageToLimits, readAntigravityUsageLimits } from "./antigravityUsageLimits.ts";

const checkedAt = "2026-10-07T00:00:00.000Z";

// `agy -p "/usage" --output-format json` from agy 1.3.0 (captured 2026-10-07, descriptions trimmed).
const usageOutput = {
  conversation_id: "",
  status: "SUCCESS",
  response: "…tab separated records…",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.75,
              reset_time: "2026-10-12T08:17:35Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "2026-10-07T05:57:00Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.5,
              reset_time: "2026-10-14T00:57:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9,
              reset_time: "2026-10-07T05:57:00Z",
            },
          ],
        },
      ],
    },
  },
};

describe("antigravityUsageToLimits", () => {
  it("turns each group's 5-hour and weekly buckets into windows of used percent", () => {
    const limits = antigravityUsageToLimits(usageOutput, checkedAt);
    expect(
      limits.windows.map(({ id, kind, label, usedPercent, windowDurationMins }) => ({
        id,
        kind,
        label,
        usedPercent: Math.round(usedPercent),
        windowDurationMins,
      })),
    ).toEqual([
      {
        id: "3p-5h",
        kind: "session",
        label: "Claude & GPT 5h",
        usedPercent: 10,
        windowDurationMins: 300,
      },
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini 5h",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "3p-weekly",
        kind: "weekly",
        label: "Claude & GPT Weekly",
        usedPercent: 50,
        windowDurationMins: 10_080,
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini Weekly",
        usedPercent: 25,
        windowDurationMins: 10_080,
      },
    ]);
    expect(limits.windows.find((window) => window.id === "gemini-weekly")?.resetsAt).toBe(
      "2026-10-12T08:17:35.000Z",
    );
  });

  it("calls an account without quota groups unsupported", () => {
    const limits = antigravityUsageToLimits(
      { command: { name: "usage", data: { groups: [] } } },
      checkedAt,
    );
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable?.reason).toBe("unsupported");
  });
});

/** A fake `agy` on PATH that records whether `/usage` was ever requested. */
function installFakeAgy(directory: string, input: { version: string; usage: unknown }) {
  const marker = NodePath.join(directory, "usage-requested");
  writeFakeCli({
    directory,
    name: "agy",
    source: [
      'import { writeFileSync } from "node:fs";',
      'if (process.argv[2] === "--version") { process.stdout.write(' +
        JSON.stringify(`${input.version}\n`) +
        "); process.exit(0); }",
      `if (process.argv[2] === "-p" && process.argv[3] === "/usage" && process.argv[4] === "--output-format" && process.argv[5] === "json") {`,
      `  writeFileSync(${JSON.stringify(marker)}, process.env.GEMINI_API_KEY ?? "absent");`,
      `  process.stdout.write(${JSON.stringify(JSON.stringify(input.usage))});`,
      "  process.exit(0);",
      "}",
      "process.exit(9);",
      "",
    ].join("\n"),
  });
  return {
    marker,
    environment: {
      PATH: `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      HOME: directory,
    },
  };
}

it.layer(NodeServices.layer)("readAntigravityUsageLimits", (it) => {
  it.effect("asks the agy CLI for /usage as a local print-mode command", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-usage-" });
      const { marker, environment } = installFakeAgy(directory, {
        version: "1.3.0",
        usage: usageOutput,
      });
      const limits = yield* readAntigravityUsageLimits({
        ...environment,
        GEMINI_API_KEY: "must-not-reach-agy",
      });
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("absent");
      expect(limits.windows).toHaveLength(4);
      expect(limits.unavailable).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("never runs /usage on an agy that would send it to the model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-old-" });
      const { marker, environment } = installFakeAgy(directory, {
        version: "1.1.10",
        usage: usageOutput,
      });
      const limits = yield* readAntigravityUsageLimits(environment);
      expect(NodeFS.existsSync(marker)).toBe(false);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an answer that took an agent turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-turn-" });
      const { environment } = installFakeAgy(directory, {
        version: "1.3.0",
        usage: { ...usageOutput, num_turns: 1 },
      });
      const limits = yield* readAntigravityUsageLimits(environment);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Antigravity could not read usage limits.",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reports a machine without agy as unsupported", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-none-" });
      const limits = yield* readAntigravityUsageLimits({ PATH: directory, HOME: directory });
      expect(limits.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );
});
