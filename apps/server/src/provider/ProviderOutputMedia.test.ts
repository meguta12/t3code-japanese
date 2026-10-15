import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Effect, FileSystem } from "effect";
import * as NodePath from "node:path";
import { makeProviderOutputMediaNormalizer } from "./ProviderOutputMedia.ts";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=";
const pngBytes = Buffer.from(pngBase64, "base64");

function event(data: unknown, provider = "codex"): ProviderRuntimeEvent {
  return {
    type: "item.completed",
    eventId: EventId.make("image-event"),
    threadId: ThreadId.make("image-thread"),
    itemId: RuntimeItemId.make("image-item"),
    provider: ProviderDriverKind.make(provider),
    createdAt: "2026-10-11T00:00:00.000Z",
    payload: { itemType: "image_view", status: "completed", data },
    raw: { source: "codex.app-server.notification", payload: data },
  };
}

const testContext = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-provider-images-" });
  return {
    fileSystem,
    root,
    normalize: makeProviderOutputMediaNormalizer({ fileSystem, attachmentsDir: root }),
  };
});

describe("provider image output normalization", () => {
  it.effect("persists Codex images once and emits small path references on repeated results", () =>
    Effect.gen(function* () {
      const { fileSystem, root, normalize } = yield* testContext;
      const source = event({
        item: { type: "imageGeneration", result: pngBase64, revisedPrompt: "猫の絵" },
      });
      const first = yield* normalize(source);
      // A fresh native envelope repeats the bytes too, exercising the
      // exclusive filesystem create rather than only the weak object cache.
      const second = yield* normalize(
        event({
          item: {
            type: "imageGeneration",
            result: pngBase64.replace(/=+$/, ""),
            revisedPrompt: "猫の絵",
          },
        }),
      );
      assert(first.type === "item.completed");
      assert(second.type === "item.completed");
      assert.deepStrictEqual(second.payload.outputMedia, first.payload.outputMedia);
      const image = first.payload.outputMedia?.[0];
      assert(image);
      assert.strictEqual(image.mimeType, "image/png");
      assert.deepStrictEqual(Buffer.from(yield* fileSystem.readFile(image.path)), pngBytes);
      assert.strictEqual(
        (yield* fileSystem.readDirectory(NodePath.join(root, "provider-media"))).length,
        1,
      );
      assert(!JSON.stringify(first).includes(pngBase64));
      assert(JSON.stringify(first).length < 1800);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps savedPath and revisedPrompt while removing a redundant inline result", () =>
    Effect.gen(function* () {
      const { fileSystem, root, normalize } = yield* testContext;
      const path = NodePath.join(root, "saved.png");
      const result = yield* normalize(
        event({
          item: {
            type: "imageGeneration",
            savedPath: path,
            result: pngBase64,
            revisedPrompt: "保存済みの絵",
          },
        }),
      );
      assert(result.type === "item.completed");
      assert.deepStrictEqual(result.payload.outputMedia, [{ type: "image", path }]);
      assert(!JSON.stringify(result).includes(pngBase64));
      assert(JSON.stringify(result).includes("保存済みの絵"));
      assert.strictEqual(yield* fileSystem.exists(NodePath.join(root, "provider-media")), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("handles Claude image source blocks and Codex MCP image content", () =>
    Effect.gen(function* () {
      const { normalize } = yield* testContext;
      const claude = yield* normalize(
        event(
          {
            toolName: "mcp__paint",
            result: {
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: pngBase64 },
                },
              ],
            },
          },
          "claude",
        ),
      );
      const mcp = yield* normalize(
        event({
          item: {
            type: "mcpToolCall",
            result: { content: [{ type: "image", mimeType: "image/png", data: pngBase64 }] },
          },
        }),
      );
      assert(claude.type === "item.completed" && mcp.type === "item.completed");
      assert.deepStrictEqual(claude.payload.outputMedia, mcp.payload.outputMedia);
      assert.strictEqual(claude.payload.outputMedia?.length, 1);
      assert(!JSON.stringify(claude).includes(pngBase64));
      assert(!JSON.stringify(mcp).includes(pngBase64));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects malformed or oversized images without forwarding inline bytes", () =>
    Effect.gen(function* () {
      const { normalize, fileSystem, root } = yield* testContext;
      for (const image of [
        { type: "imageGeneration", result: "invalid-data" },
        { type: "image", data: pngBase64, mimeType: "image/jpeg" },
        { type: "imageGeneration", result: "A".repeat(45 * 1024 * 1024) },
      ]) {
        const result = yield* normalize(event({ item: image }));
        assert(result.type === "item.completed");
        assert.strictEqual(result.payload.outputMedia, undefined);
        assert(JSON.stringify(result).length < 1000);
      }
      assert.strictEqual(yield* fileSystem.exists(NodePath.join(root, "provider-media")), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps parallel tool outputs attributed to their own item", () =>
    Effect.gen(function* () {
      const { normalize } = yield* testContext;
      const own = { type: "image", mimeType: "image/png", data: pngBase64 };
      const other = {
        type: "image",
        mimeType: "image/png",
        data: Buffer.concat([pngBytes, Buffer.from([1])]).toString("base64"),
      };
      const result = yield* normalize({
        ...event({ result: { content: [own] } }, "claudeAgent"),
        raw: {
          source: "claude.sdk.message",
          payload: {
            message: {
              content: [
                { type: "tool_result", content: [own] },
                { type: "tool_result", content: [other] },
              ],
            },
          },
        },
      });
      assert(result.type === "item.completed");
      assert.strictEqual(result.payload.outputMedia?.length, 1);
      assert(!JSON.stringify(result).includes(pngBase64));
      assert(!JSON.stringify(result).includes(other.data));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drops binary payloads without dropping the tool event when storage fails", () =>
    Effect.gen(function* () {
      const { fileSystem, root } = yield* testContext;
      const blocked = NodePath.join(root, "file-instead-of-directory");
      yield* fileSystem.writeFileString(blocked, "blocked");
      const normalize = makeProviderOutputMediaNormalizer({ fileSystem, attachmentsDir: blocked });
      const result = yield* normalize(
        event({ item: { type: "imageGeneration", result: pngBase64 } }),
      );
      assert(result.type === "item.completed");
      assert.strictEqual(result.payload.status, "completed");
      assert.strictEqual(result.payload.outputMedia, undefined);
      assert.strictEqual(result.payload.detail, "画像データを保存できませんでした");
      assert(!JSON.stringify(result).includes(pngBase64));
      assert(JSON.stringify(result).includes("画像データを保存できませんでした"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("caps output count and strips binary results from non-lifecycle raw events too", () =>
    Effect.gen(function* () {
      const { normalize, fileSystem, root } = yield* testContext;
      const content = Array.from({ length: 10 }, (_, index) => ({
        type: "image",
        mimeType: "image/png",
        data: Buffer.concat([pngBytes, Buffer.from([index])]).toString("base64"),
      }));
      const result = yield* normalize(event({ result: { content } }));
      assert(result.type === "item.completed");
      assert.strictEqual(result.payload.outputMedia?.length, 8);
      assert.strictEqual(
        (yield* fileSystem.readDirectory(NodePath.join(root, "provider-media"))).length,
        8,
      );
      assert(JSON.stringify(result).length < 7000);
      const contentEvent: ProviderRuntimeEvent = {
        ...event({}),
        type: "content.delta",
        payload: { streamKind: "command_output", delta: "画像生成完了" },
        raw: {
          source: "claude.sdk.message",
          payload: {
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: pngBase64 },
              },
            ],
          },
        },
      };
      const normalized = yield* normalize(contentEvent);
      assert(normalized.type === "content.delta");
      assert.strictEqual(normalized.payload.delta, "画像生成完了");
      assert(!JSON.stringify(normalized).includes(pngBase64));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
