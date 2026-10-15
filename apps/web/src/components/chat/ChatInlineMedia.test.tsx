import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const asset = vi.hoisted(() => ({ resources: [] as unknown[] }));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: (_id: unknown, resource: unknown) => {
    if (resource) asset.resources.push(resource);
    return { _tag: "Success", url: "https://signed.example/media" };
  },
}));

import { ChatInlineMedia } from "./ChatInlineMedia";

const threadRef = {
  environmentId: EnvironmentId.make("env-media"),
  threadId: ThreadId.make("thread-media"),
};

afterEach(() => {
  vi.unstubAllGlobals();
  asset.resources = [];
});

describe("ChatInlineMedia loading", () => {
  it("does not sign or mount a player until visible, then signs once without preloading", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const callbacks: IntersectionObserverCallback[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatInlineMedia source="~/clip.mp4" threadRef={threadRef} />, {
          createNodeMock: () => ({}),
        });
      });
      expect(asset.resources).toEqual([]);
      expect(renderer!.root.findAllByType("video")).toHaveLength(0);
      await act(async () => {
        callbacks[0]!(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(asset.resources).toEqual([]);
      await act(async () => {
        callbacks[0]!(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(asset.resources).toEqual([
        { _tag: "media-file", threadId: threadRef.threadId, path: "~/clip.mp4" },
      ]);
      const player = renderer!.root.findByType("video");
      expect(player.props.src).toBe("https://signed.example/media");
      expect(player.props.preload).toBe("none");
      expect(player.props.autoPlay).toBeUndefined();
      expect(disconnect).toHaveBeenCalled();
      await act(async () => player.props.onError());
      expect(renderer!.root.findAllByType("video")).toHaveLength(0);
      expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
        "メディアを読み込めません",
      ]);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });

  it("streams audio without autoplay and displays a failed host source clearly", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatInlineMedia source="https://example.com/voice.opus" />);
      });
      const audio = renderer!.root.findByType("audio");
      expect(audio.props.src).toBe("https://example.com/voice.opus");
      expect(audio.props.controls).toBe(true);
      expect(audio.props.preload).toBe("none");
      expect(audio.props.autoPlay).toBeUndefined();
      await act(async () => renderer!.update(<ChatInlineMedia source="/tmp/voice.wav" />));
      expect(renderer!.root.findAllByType("audio")).toHaveLength(0);
      expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
        "メディアを読み込めません",
      ]);
      expect(asset.resources).toEqual([]);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
  it("shows provider image URLs without an extension only with an explicit media kind", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <ChatInlineMedia source="https://example.com/generated?id=1" kind="image" />,
        );
      });
      expect(renderer!.root.findByType("img").props.src).toBe("https://example.com/generated?id=1");
      await act(async () =>
        renderer!.update(<ChatInlineMedia source="javascript:alert(1)" kind="image" />),
      );
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
        "メディアを読み込めません",
      ]);
      expect(asset.resources).toEqual([]);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});
