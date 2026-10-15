import { describe, expect, it } from "vite-plus/test";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

import {
  attachByReferenceThresholdBytes,
  planAttachByReference,
  referenceChipBadge,
  referenceMentionText,
  rememberReferencedFileSize,
  shouldAttachByReference,
  type AttachByReferenceMode,
} from "./attachByReference";

const MIB = 1024 * 1024;

function file(name: string, type: string, size: number): Pick<File, "name" | "type" | "size"> {
  return { name, type, size };
}

function decide(
  overrides: Partial<Parameters<typeof shouldAttachByReference>[0]> & {
    file: Pick<File, "name" | "type" | "size">;
  },
): boolean {
  return shouldAttachByReference({
    mode: "50mb",
    environmentIsLocal: true,
    path: `/Users/keita/${overrides.file.name}`,
    ...overrides,
  });
}

describe("shouldAttachByReference", () => {
  it("references video and audio of any size", () => {
    expect(decide({ file: file("clip.mp4", "video/mp4", 2 * MIB) })).toBe(true);
    expect(decide({ file: file("clip.mov", "", 2 * MIB) })).toBe(true);
    expect(decide({ file: file("voice.mp3", "audio/mpeg", 1024) })).toBe(true);
    expect(decide({ file: file("voice.m4a", "", 1024) })).toBe(true);
  });

  it("references other files only from the threshold up", () => {
    expect(decide({ file: file("a.zip", "application/zip", 50 * MIB - 1) })).toBe(false);
    expect(decide({ file: file("a.zip", "application/zip", 50 * MIB) })).toBe(true);
    expect(decide({ mode: "500mb", file: file("a.zip", "application/zip", 100 * MIB) })).toBe(
      false,
    );
    expect(decide({ mode: "10mb", file: file("a.pdf", "application/pdf", 10 * MIB) })).toBe(true);
    expect(decide({ mode: "always", file: file("a.txt", "text/plain", 3) })).toBe(true);
  });

  it("never references images, however large", () => {
    expect(decide({ mode: "always", file: file("a.png", "image/png", 900 * MIB) })).toBe(false);
    expect(decide({ mode: "always", file: file("a.heic", "image/heic", 900 * MIB) })).toBe(false);
    expect(decide({ mode: "always", file: file("a.jpg", "", 900 * MIB) })).toBe(false);
  });

  it("uploads when off, remote, empty, or the path is missing or not absolute", () => {
    const video = file("clip.mp4", "video/mp4", 80 * MIB);
    expect(decide({ mode: "off", file: video })).toBe(false);
    expect(decide({ environmentIsLocal: false, file: video })).toBe(false);
    expect(decide({ path: null, file: video })).toBe(false);
    expect(decide({ path: "clip.mp4", file: video })).toBe(false);
    expect(decide({ path: "/Users/keita/", file: video })).toBe(false);
    expect(decide({ file: file("empty.mp4", "video/mp4", 0) })).toBe(false);
  });

  it("accepts Windows drive and UNC paths", () => {
    const video = file("clip.mp4", "video/mp4", 80 * MIB);
    expect(decide({ path: "C:\\Users\\k\\clip.mp4", file: video })).toBe(true);
    expect(decide({ path: "\\\\nas\\share\\clip.mp4", file: video })).toBe(true);
  });
});

describe("attachByReferenceThresholdBytes", () => {
  it("maps every mode", () => {
    const expected: Record<AttachByReferenceMode, number | null> = {
      off: null,
      "10mb": 10 * MIB,
      "50mb": 50 * MIB,
      "500mb": 500 * MIB,
      always: 1,
    };
    for (const [mode, bytes] of Object.entries(expected)) {
      expect(attachByReferenceThresholdBytes(mode as AttachByReferenceMode)).toBe(bytes);
    }
  });
});

describe("planAttachByReference", () => {
  const video = new File(["v"], "撮影 1.mp4", { type: "video/mp4" });
  const note = new File(["n"], "memo.txt", { type: "text/plain" });
  const photo = new File(["p"], "a.png", { type: "image/png" });
  const paths = new Map<File, string>([
    [video, "/Users/keita/動画/撮影 1.mp4"],
    [note, "/Users/keita/memo.txt"],
    [photo, "/Users/keita/a.png"],
  ]);
  const getPathForFile = (f: File) => paths.get(f) ?? "";

  it("splits references from uploads", () => {
    const plan = planAttachByReference([video, note, photo], {
      mode: "50mb",
      environmentIsLocal: true,
      getPathForFile,
    });
    // File size is from the blob (1 byte): only media passes the 50 MiB gate.
    expect(plan.references).toEqual([{ file: video, path: "/Users/keita/動画/撮影 1.mp4" }]);
    expect(plan.uploads).toEqual([note, photo]);
  });

  it("uploads everything without a desktop bridge, remotely, or when the path lookup fails", () => {
    for (const input of [
      { environmentIsLocal: true, getPathForFile: undefined },
      { environmentIsLocal: false, getPathForFile },
      {
        environmentIsLocal: true,
        getPathForFile: () => {
          throw new Error("no path");
        },
      },
      { environmentIsLocal: true, getPathForFile: () => "" },
    ]) {
      const plan = planAttachByReference([video], { mode: "50mb", ...input });
      expect(plan.references).toEqual([]);
      expect(plan.uploads).toEqual([video]);
    }
  });
});

describe("reference mention text", () => {
  it("round-trips paths with spaces, Japanese and parentheses back to the same mention", () => {
    const paths = [
      "/Users/keita/動画/撮影 2026 (本番)/VID_0001.mp4",
      "/Volumes/外付け SSD/編集中/素材 [raw] #3.mov",
    ];
    const tokens = collectComposerInlineTokens(`確認して ${referenceMentionText(paths)}お願い`);
    expect(tokens.map((token) => token.value)).toEqual(paths);
  });

  it("labels absolute-path chips as 参照 with a size once the size is known", () => {
    expect(referenceChipBadge("src/index.ts")).toBeNull();
    expect(referenceChipBadge("/Users/keita/未登録.mp4")).toBe("参照");
    rememberReferencedFileSize("/Users/keita/登録済み.mp4", 3 * 1024 * MIB);
    expect(referenceChipBadge("/Users/keita/登録済み.mp4")).toBe("参照 · 3.0 GB");
  });
});
