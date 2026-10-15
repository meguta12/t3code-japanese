import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({ integrated: false }));
const openBrowser = vi.hoisted(() => vi.fn());
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => runtime.integrated,
  applyPreviewServerSnapshot: vi.fn(),
  rememberPreviewUrl: vi.fn(),
}));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({ openBrowser }) } }));
vi.mock("./browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({ viewport: { _tag: "fill" }, profileId: "default" }),
  browserDefaultOpenViewport: () => ({ _tag: "fill" }),
  browserDefaultOpenProfileId: () => "default",
}));

const { openFileInPreview } = await import("./openFileInPreview");
const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-11T00:00:00.000Z",
};
const asset = { relativeUrl: "/api/assets/signed-token/index.html", expiresAt: 1234 };
const input = () => ({
  threadRef,
  filePath: "/tmp/report/index.html",
  workspaceRoot: "/workspace",
  httpBaseUrl: "https://environment.example",
  createAssetUrl: vi.fn(async () => AsyncResult.success(asset)),
  openPreview: vi.fn(async () => AsyncResult.success(snapshot)),
});

describe("openFileInPreview", () => {
  beforeEach(() => {
    runtime.integrated = false;
    openBrowser.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reserves a web tab before signing, then navigates without an opener or referrer", async () => {
    const link = { href: "", rel: "", referrerPolicy: "", click: vi.fn(), remove: vi.fn() };
    const tab = {
      opener: {},
      document: { createElement: vi.fn(() => link), body: { append: vi.fn() } },
      close: vi.fn(),
    };
    const open = vi.fn(() => tab);
    vi.stubGlobal("window", { open });
    const options = input();
    options.createAssetUrl.mockImplementation(async () => {
      expect(open).toHaveBeenCalledWith("about:blank", "_blank");
      expect(tab.opener).toBeNull();
      return AsyncResult.success(asset);
    });
    expect((await openFileInPreview(options))._tag).toBe("Success");
    expect(link).toMatchObject({
      href: "https://environment.example/api/assets/signed-token/index.html",
      rel: "noopener noreferrer",
      referrerPolicy: "no-referrer",
    });
    expect(link.click).toHaveBeenCalledOnce();
    expect(options.openPreview).not.toHaveBeenCalled();
  });

  it("reports a blocked popup in Japanese without minting an unused grant", async () => {
    vi.stubGlobal("window", { open: () => null });
    const options = input();
    const result = await openFileInPreview(options);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(String(Cause.pretty(result.cause))).toContain("ポップアップ");
    expect(options.createAssetUrl).not.toHaveBeenCalled();
  });

  it("closes the reserved web tab when signing fails", async () => {
    const close = vi.fn();
    vi.stubGlobal("window", { open: () => ({ opener: {}, close }) });
    const options = {
      ...input(),
      createAssetUrl: async () =>
        AsyncResult.failure<typeof asset, Error>(Cause.fail(new Error("署名できません。"))),
    };
    expect((await openFileInPreview(options))._tag).toBe("Failure");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the reserved tab if signing rejects or returns a non-HTTP URL", async () => {
    const close = vi.fn();
    vi.stubGlobal("window", { open: () => ({ opener: {}, close }) });
    const options = input();
    options.createAssetUrl.mockRejectedValueOnce(new Error("接続が切れました。"));
    expect((await openFileInPreview(options))._tag).toBe("Failure");
    options.createAssetUrl.mockResolvedValueOnce(
      AsyncResult.success({ ...asset, relativeUrl: "javascript:alert(1)" }),
    );
    expect((await openFileInPreview(options))._tag).toBe("Failure");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("opens a signed document in the desktop right panel", async () => {
    runtime.integrated = true;
    const options = input();
    expect((await openFileInPreview(options))._tag).toBe("Success");
    expect(options.openPreview).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        url: "https://environment.example/api/assets/signed-token/index.html",
        viewport: { _tag: "fill" },
        profileId: "default",
      },
    });
    expect(openBrowser).toHaveBeenCalledWith(threadRef, "tab-1");
  });
});
