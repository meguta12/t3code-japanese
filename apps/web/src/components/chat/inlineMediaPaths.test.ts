import { describe, expect, it } from "vite-plus/test";

import { bareMediaPathParts, inlineMediaPathCandidate } from "./inlineMediaPaths";

describe("inline media paths", () => {
  it.each([
    "/Users/demo/映像/one frame.png",
    "~/voice.wav",
    "C:\\images\\frame.png",
    "./clip.webm",
    "frame.png",
  ])("recognizes the authored path %s", (path) =>
    expect(inlineMediaPathCandidate(path)).toBe(path),
  );
  it.each([
    "echo /tmp/frame.png",
    "npm run clip.mp4",
    "javascript:frame.png",
    "notes.ts",
    "/tmp/image.png\n",
  ])("leaves non-media commands and unsafe schemes untouched: %s", (path) =>
    expect(inlineMediaPathCandidate(path)).toBeNull(),
  );
  it("links bare media paths while preserving prose and punctuation", () => {
    const value = "画像 /Users/demo/画像.png。動画 (./clip.mp4), 音声 ~/voice.wav! src/a.ts";
    const parts = bareMediaPathParts(value);
    expect(parts.map((part) => part.text).join("")).toBe(value);
    expect(parts.flatMap((part) => part.source ?? [])).toEqual([
      "/Users/demo/画像.png",
      "./clip.mp4",
      "~/voice.wav",
    ]);
  });
});
