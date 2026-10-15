import { describe, expect, it } from "vite-plus/test";

import {
  assignMaterialOrdinals,
  buildMaterialsContext,
  findReferenceMaterialLinks,
  lowestFreeOrdinal,
  lowestFreeOrdinals,
  materialKindOf,
  planMaterialEntries,
  readReferenceMaterials,
} from "./attachmentMaterials.ts";
import { serializeComposerFileLink } from "./composerTrigger.ts";

describe("material number allocation", () => {
  it("takes the lowest free number and fills gaps left by deleted materials", () => {
    expect(lowestFreeOrdinal([])).toBe(1);
    expect(lowestFreeOrdinal([1, 2, 3])).toBe(4);
    expect(lowestFreeOrdinal([1, 3])).toBe(2);
    expect(lowestFreeOrdinals([2, 3], 3)).toEqual([1, 4, 5]);
  });

  it("does not renumber what is already there when one is deleted", () => {
    // 素材1..3 attached, 素材2 deleted: 素材3 stays 3, the next file is 2.
    const remaining = [1, 3];
    expect(assignMaterialOrdinals(remaining, [undefined])).toEqual([2]);
    expect(assignMaterialOrdinals([1, 2, 3], [undefined, undefined])).toEqual([4, 5]);
  });

  it("starts again from 1 for an empty draft", () => {
    expect(assignMaterialOrdinals([], [undefined, undefined, undefined])).toEqual([1, 2, 3]);
  });

  it("keeps a number the item already carries when it is free, else reassigns it", () => {
    expect(assignMaterialOrdinals([], [5, undefined])).toEqual([5, 1]);
    expect(assignMaterialOrdinals([5], [5, undefined])).toEqual([1, 2]);
    expect(assignMaterialOrdinals([], [7, 7])).toEqual([7, 1]);
    expect(assignMaterialOrdinals([], [0, -1, 1.5, Number.NaN])).toEqual([1, 2, 3, 4]);
  });

  it("numbers 25 materials without gaps or repeats", () => {
    const numbers = assignMaterialOrdinals(
      [],
      Array.from({ length: 25 }, () => undefined),
    );
    expect(numbers).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  });
});

describe("materialKindOf", () => {
  it("classifies by mime type and falls back to the extension", () => {
    expect(materialKindOf({ name: "a.png", mimeType: "image/png" })).toBe("image");
    expect(materialKindOf({ name: "clip.mov", mimeType: "video/quicktime" })).toBe("video");
    expect(materialKindOf({ name: "clip.mkv", mimeType: "" })).toBe("video");
    expect(materialKindOf({ name: "voice.m4a", mimeType: "application/octet-stream" })).toBe(
      "audio",
    );
    expect(materialKindOf({ name: "x.mp3", mimeType: "audio/mpeg" })).toBe("audio");
    expect(materialKindOf({ name: "doc.pdf", mimeType: "application/pdf" })).toBe("pdf");
    expect(materialKindOf({ name: "notes.txt", mimeType: "text/plain" })).toBe("file");
  });
});

describe("reference labels", () => {
  const withSpaces = "/Users/keita/動画 素材/大きい 動画.mov";
  const plain = "/Users/keita/clip.mp4";
  const prompt = `この ${serializeComposerFileLink(plain)} と ${serializeComposerFileLink(withSpaces)} を比べて`;

  it("uses typed ordinals even when the filename looks like a material label", () => {
    const path = "/Users/keita/素材3 intro.mp4";
    expect(readReferenceMaterials([{ ordinal: 7, path }])).toEqual([
      { ordinal: 7, path, name: "素材3 intro.mp4" },
    ]);
    expect(readReferenceMaterials()).toEqual([]);
  });

  it("reads only typed references and preserves their file names", () => {
    expect(
      readReferenceMaterials([
        { ordinal: 2, path: plain },
        { ordinal: 5, path: withSpaces },
      ]),
    ).toEqual([
      { ordinal: 2, path: plain, name: "clip.mp4" },
      { ordinal: 5, path: withSpaces, name: "大きい 動画.mov" },
    ]);
  });

  it("finds the references the composer should show tiles for", () => {
    expect(findReferenceMaterialLinks(prompt, { [plain]: 2, "/other/x.mov": 9 })).toEqual([
      { ordinal: 2, path: plain },
    ]);
    expect(findReferenceMaterialLinks(prompt, {})).toEqual([]);
  });
});

describe("provider materials table", () => {
  it("is absent when nothing is numbered", () => {
    expect(
      planMaterialEntries([
        { kind: "image", name: "a.png", path: "/att/a.png" },
        { kind: "file", name: "b.txt", path: "/att/b.txt" },
      ]),
    ).toBeNull();
    expect(planMaterialEntries([])).toBeNull();
  });

  it("lists images, files and references under their own numbers, in number order", () => {
    const entries = planMaterialEntries([
      { ordinal: 3, kind: "image", name: "foo.png", path: "/att/foo.png" },
      { ordinal: 1, kind: "video", name: "clip.mp4", path: "/att/clip.mp4" },
      {
        ordinal: 2,
        kind: "reference",
        name: "big movie.mov",
        path: "/Users/k/動画 素材/big movie.mov",
      },
    ]);
    expect(buildMaterialsContext(entries!)).toBe(
      [
        "添付素材（ユーザーが「素材N」と書いたら、次の対応表のファイルを指す。画像は画像としても添付されている）:",
        "素材1 = 動画 clip.mp4 (/att/clip.mp4)",
        "素材2 = 参照 big movie.mov (/Users/k/動画 素材/big movie.mov)",
        "素材3 = 画像 foo.png (/att/foo.png)",
      ].join("\n"),
    );
  });

  it("gives unnumbered items the lowest free numbers and never repeats one", () => {
    const entries = planMaterialEntries([
      { kind: "file", name: "old.txt", path: "/att/old.txt" },
      { ordinal: 1, kind: "image", name: "a.png", path: null },
      { ordinal: 1, kind: "image", name: "dup.png", path: null },
      { ordinal: 2, kind: "file", name: "b.txt", path: "/att/b.txt" },
    ]);
    expect(entries!.map((entry) => [entry.ordinal, entry.name])).toEqual([
      [1, "a.png"],
      [2, "b.txt"],
      [3, "old.txt"],
      [4, "dup.png"],
    ]);
    expect(buildMaterialsContext(entries!)).toContain("素材1 = 画像 a.png\n");
  });
});
