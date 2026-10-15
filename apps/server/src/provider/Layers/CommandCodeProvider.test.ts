import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { CommandCodeSettings, type ServerProviderModel } from "@t3tools/contracts";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  checkCommandCodeProviderStatus,
  commandCodeModelCapabilities,
  COMMANDCODE_DEFAULT_MODEL_SLUG,
  parseCommandCodeModelsOutput,
  parseCommandCodeStatusOutput,
} from "./CommandCodeProvider.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);

// Trimmed capture of `commandcode --list-models` (1.74.3): group headings, aligned rows,
// a "(default)" marker, and the trailing sections that must not be parsed as models.
const LIST_MODELS_OUTPUT = [
  "Available models  ·  6 models",
  "",
  "Open Source",
  "",
  "deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning",
  "deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)",
  "z-ai/glm-5.3-flashx                    high-speed GLM-5.3 Flash with 1M context",
  "inclusionai/ling-3.1-flash:free        FREE hybrid-reasoning MoE for coding & tool-using agents",
  "",
  "Anthropic",
  "",
  "claude-sonnet-5-5                      best combo of speed & intelligence (recommended)",
  "claude-haiku-4-5                       fastest & most compact, great for quick tasks",
  "",
  'Pass the full id, or just the short name after the last "/":',
  "cmd --model moonshotai/kimi-k2.5",
  "",
  "Decision models (headless only)",
  "typesafe/jev  typed questions in, probabilities out",
].join("\n");

const effortValues = (model: ServerProviderModel | undefined) =>
  model?.capabilities?.optionDescriptors?.flatMap((descriptor) =>
    descriptor.type === "select" ? [descriptor.options.map((option) => option.id)] : [],
  )[0];

describe("parseCommandCodeModelsOutput", () => {
  const models = parseCommandCodeModelsOutput(LIST_MODELS_OUTPUT);

  it("keeps the CLI ids, groups them as sub-providers, and marks the default", () => {
    expect(models.map((model) => [model.slug, model.subProvider])).toEqual([
      ["deepseek/deepseek-v4-pro", "Open Source"],
      ["deepseek/deepseek-v4-flash", "Open Source"],
      ["z-ai/glm-5.3-flashx", "Open Source"],
      ["inclusionai/ling-3.1-flash:free", "Open Source"],
      ["claude-sonnet-5-5", "Anthropic"],
      ["claude-haiku-4-5", "Anthropic"],
    ]);
    expect(models.filter((model) => model.isDefault).map((model) => model.slug)).toEqual([
      COMMANDCODE_DEFAULT_MODEL_SLUG,
    ]);
    expect(models.find((model) => model.slug === "z-ai/glm-5.3-flashx")?.name).toBe(
      "glm-5.3-flashx",
    );
  });

  it("exposes an effort option except where the agent offers none", () => {
    expect(effortValues(models.find((model) => model.slug === "claude-sonnet-5-5"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortValues(models.find((model) => model.slug === "deepseek/deepseek-v4-pro"))).toEqual(
      ["off", "high", "max"],
    );
    expect(commandCodeModelCapabilities("claude-haiku-4-5").optionDescriptors).toEqual([]);
  });

  it("returns nothing for output that is not a model list", () => {
    expect(parseCommandCodeModelsOutput("error: not logged in\n")).toEqual([]);
    expect(parseCommandCodeModelsOutput("\u001b[31mAvailable models\u001b[0m\n")).toEqual([]);
  });
});

describe("parseCommandCodeStatusOutput", () => {
  it("recognizes a verified login and the account name", () => {
    expect(
      parseCommandCodeStatusOutput(
        "- Checking authentication status...\n✔ Authentication verified\n✔ Authenticated as someone\n  Provider: Command Code\n",
        0,
      ),
    ).toEqual({ authenticated: true, account: "someone" });
  });

  it("treats logged-out wording and failing exits as signed out", () => {
    expect(parseCommandCodeStatusOutput("You are not logged in. Run cmd login.", 0)).toEqual({
      authenticated: false,
    });
    expect(parseCommandCodeStatusOutput("something went wrong", 1)).toEqual({
      authenticated: false,
    });
  });

  it("leaves unrecognized output unknown", () => {
    expect(parseCommandCodeStatusOutput("ok", 0)).toEqual({ authenticated: null });
  });
});

it.layer(NodeServices.layer)("checkCommandCodeProviderStatus", (it) => {
  const writeFakeCommandCode = (input: {
    readonly statusOutput: string;
    readonly statusExit?: number;
    readonly listModels: boolean;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-commandcode-probe-" });
      return writeFakeCli({
        directory: dir,
        name: "commandcode",
        source: [
          "const arg = process.argv[2];",
          'if (arg === "--version") { process.stdout.write("1.74.3\\n"); process.exit(0); }',
          'if (arg === "status") {',
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `  process.stdout.write(${JSON.stringify(input.statusOutput)});`,
          `  process.exit(${input.statusExit ?? 0});`,
          "}",
          'if (arg === "--list-models") {',
          input.listModels
            ? // @effect-diagnostics-next-line preferSchemaOverJson:off
              `  process.stdout.write(${JSON.stringify(LIST_MODELS_OUTPUT)}); process.exit(0);`
            : "  process.exit(1);",
          "}",
          "process.exit(1);",
          "",
        ].join("\n"),
      });
    });

  const check = (
    settings: Parameters<typeof decodeSettings>[0],
    cache: Ref.Ref<ReadonlyArray<ServerProviderModel>>,
  ) => checkCommandCodeProviderStatus(decodeSettings(settings), process.env, cache);

  it.effect("reports a missing binary", () =>
    Effect.gen(function* () {
      const cache = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
      const snapshot = yield* check(
        { enabled: true, binaryPath: "/definitely/not/installed/commandcode" },
        cache,
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("stays disabled without probing the CLI", () =>
    Effect.gen(function* () {
      const cache = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
      const snapshot = yield* check({ binaryPath: "/definitely/not/installed/commandcode" }, cache);
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual([COMMANDCODE_DEFAULT_MODEL_SLUG]);
    }),
  );

  it.effect("is ready with the listed models and the logged-in account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* writeFakeCommandCode({
          statusOutput: "✔ Authentication verified\n✔ Authenticated as someone\n",
          listModels: true,
        });
        const cache = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
        const snapshot = yield* check({ enabled: true, binaryPath }, cache);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.version).toBe("1.74.3");
        expect(snapshot.auth).toEqual({
          status: "authenticated",
          type: "cached_token",
          label: "Command Code (someone)",
        });
        expect(snapshot.models).toHaveLength(6);
        expect((yield* Ref.get(cache)).length).toBe(6);
      }),
    ),
  );

  it.effect("reports a signed-out CLI with the login hint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* writeFakeCommandCode({
          statusOutput: "You are not logged in.\n",
          statusExit: 1,
          listModels: false,
        });
        const cache = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
        const snapshot = yield* check({ enabled: true, binaryPath }, cache);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth).toEqual({ status: "unauthenticated" });
        expect(snapshot.message).toContain("commandcode login");
      }),
    ),
  );

  it.effect("keeps the last good catalog when a refresh cannot list models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* writeFakeCommandCode({
          statusOutput: "✔ Authentication verified\n",
          listModels: false,
        });
        const cached = parseCommandCodeModelsOutput(LIST_MODELS_OUTPUT);
        const cache = yield* Ref.make<ReadonlyArray<ServerProviderModel>>(cached);
        const snapshot = yield* check({ enabled: true, binaryPath }, cache);
        expect(snapshot.status).toBe("warning");
        expect(snapshot.models.map((model) => model.slug)).toEqual(cached.map((m) => m.slug));
      }),
    ),
  );
});
