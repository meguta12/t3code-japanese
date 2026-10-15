import type { ClientSettings } from "@t3tools/contracts/settings";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { videoMimeType } from "@t3tools/shared/video";

import { classifyComposerAttachmentFile } from "./composerAttachmentFiles";

/**
 * "Attach by reference": a big video or audio file on the Mac that runs the
 * server is not copied into attachment storage. The composer inserts a file
 * link mention of its original absolute path instead (the same mention a
 * dropped folder gets), and providers read it by path just like the
 * "[Attached file ... is saved at: ...]" line they get for uploads.
 */
export type AttachByReferenceMode = ClientSettings["attachByReference"];

export const ATTACH_BY_REFERENCE_OPTIONS: ReadonlyArray<{
  readonly value: AttachByReferenceMode;
  readonly label: string;
}> = [
  { value: "10mb", label: "10 MiB以上" },
  { value: "50mb", label: "50 MiB以上（既定）" },
  { value: "500mb", label: "500 MiB以上" },
  { value: "always", label: "常に参照（画像以外）" },
  { value: "off", label: "使わない" },
];

const MIB = 1024 * 1024;

/** Size from which a non-media file is referenced; `null` turns the feature off. */
export function attachByReferenceThresholdBytes(mode: AttachByReferenceMode): number | null {
  switch (mode) {
    case "off":
      return null;
    case "always":
      return 1;
    case "10mb":
      return 10 * MIB;
    case "50mb":
      return 50 * MIB;
    case "500mb":
      return 500 * MIB;
  }
}

const AUDIO_FILE_EXTENSIONS = new Set([
  "aac",
  "aif",
  "aiff",
  "caf",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  "wma",
]);

function isMediaFile(file: Pick<File, "name" | "type">): boolean {
  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) return true;
  if (videoMimeType({ name: file.name, mimeType: file.type }) !== null) return true;
  const dotIndex = file.name.lastIndexOf(".");
  return dotIndex > 0 && AUDIO_FILE_EXTENSIONS.has(file.name.slice(dotIndex + 1).toLowerCase());
}

/** A POSIX, Windows drive or UNC absolute path. A relative path means nothing to the server. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function pathBasename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/**
 * Whether one file should be referenced instead of uploaded. Images always
 * upload (the model reads their bytes). Directories never reach this path;
 * a zero-byte file is not worth referencing and keeps the upload error.
 */
export function shouldAttachByReference(input: {
  mode: AttachByReferenceMode;
  /** The composer's environment is the server this desktop app runs itself. */
  environmentIsLocal: boolean;
  file: Pick<File, "name" | "type" | "size">;
  /** What `webUtils.getPathForFile` returned, or null when it is unavailable. */
  path: string | null;
}): boolean {
  const threshold = attachByReferenceThresholdBytes(input.mode);
  if (threshold === null || !input.environmentIsLocal) return false;
  const { file, path } = input;
  if (path === null || !isAbsolutePath(path) || pathBasename(path).length === 0) return false;
  if (file.size <= 0) return false;
  if (classifyComposerAttachmentFile(file) !== "file") return false;
  return isMediaFile(file) || file.size >= threshold;
}

export interface AttachByReferencePlan {
  readonly references: ReadonlyArray<{ readonly file: File; readonly path: string }>;
  readonly uploads: File[];
}

/** Splits a drop, pick or paste into files to reference and files to upload as before. */
export function planAttachByReference(
  files: ReadonlyArray<File>,
  input: {
    mode: AttachByReferenceMode;
    environmentIsLocal: boolean;
    getPathForFile: ((file: File) => string) | undefined;
  },
): AttachByReferencePlan {
  const references: Array<{ file: File; path: string }> = [];
  const uploads: File[] = [];
  for (const file of files) {
    let path: string | null = null;
    if (input.environmentIsLocal && input.mode !== "off" && input.getPathForFile) {
      try {
        const resolved = input.getPathForFile(file);
        path = typeof resolved === "string" && resolved.length > 0 ? resolved : null;
      } catch {
        path = null;
      }
    }
    if (path !== null && shouldAttachByReference({ ...input, file, path })) {
      references.push({ file, path });
    } else {
      uploads.push(file);
    }
  }
  return { references, uploads };
}

/** Text inserted into the composer for the referenced files; each link is followed by a space. */
export function referenceMentionText(paths: ReadonlyArray<string>): string {
  return paths.map((path) => `${serializeComposerFileLink(path)} `).join("");
}

// Sizes of files attached by reference in this session, so the chip can say
// how big the original is. The link itself carries only the path; after a
// reload the chip shows 参照 without a size.
const referencedFileSizes = new Map<string, number>();

export function rememberReferencedFileSize(path: string, sizeBytes: number): void {
  referencedFileSizes.set(path, sizeBytes);
}

export function referencedFileSize(path: string): number | null {
  return referencedFileSizes.get(path) ?? null;
}

/** 「参照」 chip text for an absolute-path mention, e.g. "参照 · 1.2 GB". */
export function referenceChipBadge(path: string): string | null {
  if (!isAbsolutePath(path)) return null;
  const sizeBytes = referencedFileSizes.get(path);
  return sizeBytes === undefined ? "参照" : `参照 · ${formatAttachmentSize(sizeBytes)}`;
}

export function referenceChipTooltip(path: string): string {
  return `${path}\nコピーせず元の場所を参照しています。元のファイルを移動・削除すると読めなくなります。`;
}
