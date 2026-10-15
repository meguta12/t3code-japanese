import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { buildComposerMaterials } from "./composerMaterials";

function image(id: string, ordinal: number | undefined, name = `${id}.png`) {
  return {
    type: "image",
    id,
    name,
    mimeType: "image/png",
    sizeBytes: 10,
    previewUrl: `blob:${id}`,
    file: new File(["x"], name, { type: "image/png" }),
    ...(ordinal === undefined ? {} : { ordinal }),
  } satisfies ComposerImageAttachment;
}

function file(id: string, ordinal: number | undefined, name: string, mimeType: string) {
  return {
    type: "file",
    id,
    name,
    mimeType,
    sizeBytes: 20,
    file: new File(["x"], name, { type: mimeType }),
    ...(ordinal === undefined ? {} : { ordinal }),
  } satisfies ComposerFileAttachment;
}

const base = {
  nonPersistedImageIds: new Set<string>(),
  trackImageUploads: true,
  canUploadFile: () => true,
  isNeedsReattach: () => false,
  referenceSize: () => null,
};

describe("buildComposerMaterials", () => {
  it("orders tiles by their number, mixing images, files and references", () => {
    const materials = buildComposerMaterials({
      ...base,
      images: [image("a", 3), image("b", 1)],
      files: [file("c", 4, "clip.mp4", "video/mp4"), file("d", 6, "voice.m4a", "")],
      references: [{ ordinal: 2, path: "/Users/k/動画 素材/大きい 動画.mov" }],
      referenceSize: (path) => (path.endsWith(".mov") ? 5_000_000_000 : null),
    });
    expect(materials.map((m) => [m.ordinal, m.kind, m.name])).toEqual([
      [1, "image", "b.png"],
      [2, "reference", "大きい 動画.mov"],
      [3, "image", "a.png"],
      [4, "video", "clip.mp4"],
      [6, "audio", "voice.m4a"],
    ]);
    expect(materials[1]).toMatchObject({
      key: "ref:/Users/k/動画 素材/大きい 動画.mov",
      referencePath: "/Users/k/動画 素材/大きい 動画.mov",
      sizeBytes: 5_000_000_000,
      trackUpload: false,
    });
  });

  it("never repeats a number and numbers an unnumbered attachment last-free", () => {
    const materials = buildComposerMaterials({
      ...base,
      images: [image("a", 2), image("dup", 2), image("old", undefined)],
      files: [file("f", 1, "r.pdf", "application/pdf")],
      references: [],
    });
    expect(materials.map((m) => [m.ordinal, m.key])).toEqual([
      [1, "f"],
      [2, "a"],
      [3, "dup"],
      [4, "old"],
    ]);
    expect(new Set(materials.map((m) => m.ordinal)).size).toBe(materials.length);
  });

  it("marks files that need to be attached again and files whose upload is tracked", () => {
    const reloaded = { ...file("g", 1, "report.pdf", "application/pdf"), file: null };
    const materials = buildComposerMaterials({
      ...base,
      images: [],
      files: [reloaded, file("h", 2, "notes.txt", "text/plain")],
      references: [],
      isNeedsReattach: (candidate) => candidate.file === null,
      canUploadFile: (candidate) => candidate.id === "h",
    });
    expect(materials.map((m) => [m.key, m.needsReattach, m.trackUpload, m.kind])).toEqual([
      ["g", true, false, "pdf"],
      ["h", false, true, "file"],
    ]);
  });
});
