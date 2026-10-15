import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { build } from "vite-plus";
import * as TestClock from "effect/testing/TestClock";
import * as NodeVM from "node:vm";
import { vi } from "vite-plus/test";
import { readMediaFileText, openMediaFile } from "./MediaFile.ts";
import { assetFileResponse } from "../http.ts";
import { prepareHtmlPreview, rewritePreviewRootUrls, htmlPreviewPolicy } from "./HtmlPreview.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import { assetResponseHeaders } from "../http.ts";
import { issueAssetUrl, resolveAsset } from "./AssetAccess.ts";

const config = ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-html-preview-" });
const layer = Layer.mergeAll(
  config,
  NodeHttpPlatform.layer,
  WorkspacePaths.layer,
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({ resolve: () => Effect.succeed(null) }),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({
    resolvePath: () => Effect.succeed(null),
  }),
  ServerSecretStore.layer.pipe(Layer.provide(config)),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("built Vite HTML preview", () => {
  it.effect("loads the built module and sibling JSON/media outside the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vite-html-" });
      yield* fs.makeDirectory(path.join(project, "public"));
      yield* fs.writeFileString(
        path.join(project, "index.html"),
        '<!doctype html><main id="app"></main><img src="./picture.svg"><video src="./clip.mp4"></video><script type="module" src="./main.js"></script>',
      );
      yield* fs.writeFileString(
        path.join(project, "main.js"),
        'import "./style.css"; localStorage.setItem("preview","ok"); fetch("./data.json").then(r=>r.json()).then(d=>document.querySelector("#app").textContent=d.message);',
      );
      yield* fs.writeFileString(path.join(project, "style.css"), "body { color: red; }");
      for (const [name, contents] of [
        ["data.json", '{"message":"表示確認"}'],
        ["picture.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
        ["clip.mp4", "fixture"],
      ])
        yield* fs.writeFileString(path.join(project, "public", name!), contents!);
      yield* Effect.promise(() =>
        build({ configFile: false, root: project, base: "./", logLevel: "silent" }),
      );
      const root = path.join(project, "dist");
      const html = yield* fs.readFileString(path.join(root, "index.html"));
      const modulePath = /type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
      expect(modulePath).toBeTruthy();
      const signed = yield* issueAssetUrl({
        resource: {
          _tag: "media-file",
          threadId: ThreadId.make("fixture"),
          path: path.join(root, "index.html"),
        },
        workspaceRoot: yield* fs.makeTempDirectoryScoped(),
      });
      const token = signed.relativeUrl.split("/")[3]!;
      const cssPath = /rel="stylesheet"[^>]*href="([^"]+)"/.exec(html)?.[1];
      expect(cssPath).toBeTruthy();
      for (const name of [
        modulePath!.replace(/^\.\//, ""),
        cssPath!.replace(/^\.\//, ""),
        "data.json",
        "picture.svg",
        "clip.mp4",
      ]) {
        expect(yield* resolveAsset(token, name)).not.toBeNull();
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "rejects unsigned, tampered, traversal and symlink escapes even within the workspace",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fs.makeTempDirectoryScoped();
        const root = path.join(workspace, "site");
        yield* fs.makeDirectory(root);
        yield* fs.writeFileString(path.join(root, "index.html"), "<!doctype html>");
        yield* fs.writeFileString(path.join(workspace, "private.json"), "secret");
        yield* fs.writeFileString(path.join(root, ".env"), "secret");
        yield* fs.symlink(path.join(root, ".env"), path.join(root, "alias.json"));
        yield* fs.symlink(path.join(workspace, "private.json"), path.join(root, "escape.json"));
        const signed = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("fixture"),
            path: "site/index.html",
          },
          workspaceRoot: workspace,
        });
        const token = signed.relativeUrl.split("/")[3]!;
        for (const name of [
          "../private.json",
          "%2e%2e/private.json",
          "..%2fprivate.json",
          "%252e%252e/private.json",
          "escape.json",
          "alias.json",
          ".env",
          "/private.json",
          "..\\private.json",
          "index.html%00",
        ])
          expect(yield* resolveAsset(token, name)).toBeNull();
        for (const invalid of ["", `${token}x`, `${token}.extra`, token.split(".")[0]!])
          expect(yield* resolveAsset(invalid, "index.html")).toBeNull();
        yield* TestClock.adjust(2 * 60 * 60 * 1000);
        expect(yield* resolveAsset(token, "index.html")).not.toBeNull();
        yield* TestClock.adjust(7 * 24 * 60 * 60 * 1000);
        expect(yield* resolveAsset(token, "index.html")).toBeNull();
      }).pipe(Effect.provide(layer)),
  );

  it("allows credential-free module requests from an isolated document origin", () => {
    expect(
      assetResponseHeaders("module.js", { previewToken: "signed-token" })[
        "Access-Control-Allow-Origin"
      ],
    ).toBe("*");
    expect(assetResponseHeaders("module.js")["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(assetResponseHeaders("index.html")["Content-Security-Policy"]).not.toContain(
      "allow-same-origin",
    );
  });

  it("keeps app APIs, frames, workers and forms outside the opaque document capability", () => {
    const policy = htmlPreviewPolicy("signed-token");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain(
      "connect-src http://*:*/api/assets/signed-token/ https://*:*/api/assets/signed-token/",
    );
    for (const directive of [
      "worker-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ])
      expect(policy).toContain(directive);
    const rewritten = rewritePreviewRootUrls(
      'import("/assets/a.js"); const route = "/settings"; fetch("/data.json");',
      "signed-token",
    );
    expect(rewritten).toContain('import("/api/assets/signed-token/assets/a.js")');
    expect(rewritten).toContain('const route = "/settings"');
  });

  it.effect("keeps full source on short reads and does no source read for HEAD", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const filePath = path.join(root, "index.html");
      const source = "<!-- note -->\n<!doctype html><p>全文</p>";
      yield* fs.writeFileString(filePath, source);
      const canonical = yield* fs.realPath(filePath);
      const file = yield* openMediaFile(canonical);
      if (!file) throw new Error("Expected fixture descriptor");
      const bytes = new TextEncoder().encode(source);
      const read = vi.spyOn(file.handle, "read").mockImplementation(async (...args: unknown[]) => {
        const buffer = args[0] as Uint8Array;
        const offset = args[1] as number;
        const position = args[3] as number;
        const chunk = bytes.subarray(position, position + 3);
        buffer.set(chunk, offset);
        return { bytesRead: chunk.length, buffer };
      });
      expect(yield* readMediaFileText(canonical, file, bytes.length)).toBe(source);
      expect(read.mock.calls.length).toBeGreaterThan(1);
      read.mockClear();
      expect(
        (yield* assetFileResponse(
          { path: canonical, file, mimeType: "text/html", previewToken: "token" },
          undefined,
          undefined,
          "HEAD",
        )).status,
      ).toBe(200);
      expect(read).not.toHaveBeenCalled();
      expect(prepareHtmlPreview(source, "token")).toMatch(
        /^<!-- note -->\n<!doctype html><script>/,
      );
      read.mockRestore();
    }).pipe(Effect.provide(layer)),
  );

  it("runs storage and relative/root JSON fetch without credentials on LAN and relay hosts", async () => {
    for (const origin of ["http://192.168.1.20:3773", "https://environment.t3.example"]) {
      const requests: Array<{ url: string; credentials: string }> = [];
      const context = NodeVM.createContext({
        URL,
        Request,
        DOMException,
        location: { href: `${origin}/api/assets/signed-token/index.html` },
        fetch: async (url: URL, init: RequestInit) => {
          requests.push({ url: String(url), credentials: init.credentials! });
          return { ok: true };
        },
      });
      NodeVM.runInContext("window = globalThis", context);
      const html = prepareHtmlPreview(
        '<!doctype html><base href="/api/"><main></main>',
        "signed-token",
      );
      expect(html).toMatch(/^<!doctype html><script>/);
      expect(html).not.toContain("<base");
      const bootstrap = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
      NodeVM.runInContext(bootstrap, context);
      expect(
        NodeVM.runInContext(
          'localStorage.setItem("test", "ok"); localStorage.getItem("test")',
          context,
        ),
      ).toBe("ok");
      expect(NodeVM.runInContext('sessionStorage.test = "ok"; sessionStorage.test', context)).toBe(
        "ok",
      );
      await NodeVM.runInContext('fetch("/data.json", { credentials: "include" })', context);
      expect(requests).toEqual([
        { url: `${origin}/api/assets/signed-token/data.json`, credentials: "omit" },
      ]);
      await NodeVM.runInContext('fetch("/api/assets/signed-token/data.json")', context);
      expect(requests[1]?.url).toBe(`${origin}/api/assets/signed-token/data.json`);
      NodeVM.runInContext(
        `location.href = ${JSON.stringify(`${origin}/api/assets/signed-token/pages/view.html`)}`,
        context,
      );
      await NodeVM.runInContext('fetch("./data.json")', context);
      expect(requests[2]?.url).toBe(`${origin}/api/assets/signed-token/pages/data.json`);
      for (const url of [
        "../../private.json",
        `${origin}/api/settings`,
        "https://outside.example/data.json",
      ])
        await expect(
          NodeVM.runInContext(`fetch(${JSON.stringify(url)})`, context),
        ).rejects.toThrow();
    }
  });
});
