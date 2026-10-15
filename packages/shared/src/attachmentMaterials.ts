import { collectComposerInlineTokens } from "./composerInlineTokens.ts";
import { videoMimeType } from "./video.ts";

/**
 * "素材N": every file attached to a message gets a number the user can use in
 * the text ("素材3 を背景に使って"). The composer assigns the numbers and keeps
 * them stable while the draft lives; the provider prompt carries the table
 * that says which file each number is.
 */
export type MaterialKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "file"
  | "pasted-text"
  | "reference";

export const MATERIAL_KIND_LABEL: Readonly<Record<MaterialKind, string>> = {
  image: "画像",
  video: "動画",
  audio: "音声",
  pdf: "PDF",
  file: "ファイル",
  "pasted-text": "貼り付けテキスト",
  reference: "参照",
};

export function formatMaterialName(ordinal: number): string {
  return `素材${ordinal}`;
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

function extensionOf(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : "";
}

/** The kind label of a file, from its mime type and, when that says nothing, its extension. */
export function materialKindOf(input: {
  readonly name: string;
  readonly mimeType: string;
}): Exclude<MaterialKind, "pasted-text" | "reference"> {
  const mimeType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("image/")) return "image";
  if (videoMimeType(input) !== null) return "video";
  if (mimeType.startsWith("audio/") || AUDIO_FILE_EXTENSIONS.has(extensionOf(input.name))) {
    return "audio";
  }
  if (mimeType === "application/pdf" || extensionOf(input.name) === "pdf") return "pdf";
  return "file";
}

/** The `count` smallest positive integers that are not in `used`, ascending. */
export function lowestFreeOrdinals(used: Iterable<number>, count: number): number[] {
  const taken = new Set<number>(used);
  const free: number[] = [];
  for (let candidate = 1; free.length < count; candidate += 1) {
    if (!taken.has(candidate)) free.push(candidate);
  }
  return free;
}

export function lowestFreeOrdinal(used: Iterable<number>): number {
  return lowestFreeOrdinals(used, 1)[0]!;
}

export function isMaterialOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Gives every incoming item a number: the one it already carries when that is
 * valid and free (a restored draft keeps its numbers), otherwise the lowest
 * free one. `used` is the set of numbers already taken; it is not mutated.
 */
export function assignMaterialOrdinals(
  used: Iterable<number>,
  incoming: ReadonlyArray<number | undefined>,
): number[] {
  const taken = new Set<number>(used);
  const result: Array<number | null> = incoming.map((wanted) => {
    if (isMaterialOrdinal(wanted) && !taken.has(wanted)) {
      taken.add(wanted);
      return wanted;
    }
    return null;
  });
  const unassigned = result.filter((value) => value === null).length;
  const free = lowestFreeOrdinals(taken, unassigned);
  let next = 0;
  return result.map((value) => value ?? free[next++]!);
}

/** One file attached by reference that is in the prompt text, with its number. */
export interface ReferenceMaterial {
  readonly ordinal: number;
  readonly path: string;
  readonly name: string;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

function basenameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Absolute-path file links in the prompt, with the path each one decodes to. */
function absoluteFileLinks(prompt: string) {
  // Tokens need a following whitespace, and a sent prompt is trimmed.
  const text = `${prompt}\n`;
  return {
    text,
    links: collectComposerInlineTokens(text).filter(
      (token) =>
        token.type === "mention" && token.source.startsWith("[") && isAbsolutePath(token.value),
    ),
  };
}

/** References come from the typed message metadata, never from file names or link labels. */
export function readReferenceMaterials(
  references: ReadonlyArray<{ readonly ordinal: number; readonly path: string }> = [],
): ReferenceMaterial[] {
  const seen = new Set<number>();
  return references.flatMap((reference) => {
    if (
      !isMaterialOrdinal(reference.ordinal) ||
      !isAbsolutePath(reference.path) ||
      seen.has(reference.ordinal)
    )
      return [];
    seen.add(reference.ordinal);
    return [{ ...reference, name: basenameOf(reference.path) }];
  });
}

/** The numbered references the composer shows for the current prompt. */
export function findReferenceMaterialLinks(
  prompt: string,
  ordinalByPath: Readonly<Record<string, number>>,
): Array<{ readonly ordinal: number; readonly path: string }> {
  if (!prompt.includes("](")) return [];
  const seen = new Set<string>();
  const found: Array<{ ordinal: number; path: string }> = [];
  for (const token of absoluteFileLinks(prompt).links) {
    const ordinal = ordinalByPath[token.value];
    if (!isMaterialOrdinal(ordinal) || seen.has(token.value)) continue;
    seen.add(token.value);
    found.push({ ordinal, path: token.value });
  }
  return found;
}

export interface MaterialContextEntry {
  readonly ordinal: number;
  readonly kind: MaterialKind;
  readonly name: string;
  /** Where the file is on the machine that runs the agent; null when it cannot be resolved. */
  readonly path: string | null;
}

export interface MaterialInput {
  readonly ordinal?: number | undefined;
  readonly kind: MaterialKind;
  readonly name: string;
  readonly path: string | null;
}

/**
 * The numbered table for a message, or null when nothing in it is numbered
 * (a client that does not number attachments keeps the plain path lines).
 * Items without a number get the lowest numbers no other item uses, so a
 * mixed message never repeats a number.
 */
export function planMaterialEntries(
  inputs: ReadonlyArray<MaterialInput>,
): MaterialContextEntry[] | null {
  if (inputs.length === 0 || !inputs.some((input) => isMaterialOrdinal(input.ordinal))) return null;
  // Numbered items claim their numbers first (the first claimant wins), then
  // the rest fill the gaps in message order.
  const claimed = new Set<number>();
  const ordinals: Array<number | undefined> = inputs.map((input) => {
    if (!isMaterialOrdinal(input.ordinal) || claimed.has(input.ordinal)) return undefined;
    claimed.add(input.ordinal);
    return input.ordinal;
  });
  const free = lowestFreeOrdinals(claimed, ordinals.filter((value) => value === undefined).length);
  let next = 0;
  return inputs
    .map((input, index) => ({
      ordinal: ordinals[index] ?? free[next++]!,
      kind: input.kind,
      name: input.name,
      path: input.path,
    }))
    .sort((left, right) => left.ordinal - right.ordinal);
}

/** The prompt block that tells the agent what each 素材N is. */
export function buildMaterialsContext(entries: ReadonlyArray<MaterialContextEntry>): string {
  const lines = entries.map((entry) => {
    const where = entry.path === null ? "" : ` (${entry.path})`;
    return `${formatMaterialName(entry.ordinal)} = ${MATERIAL_KIND_LABEL[entry.kind]} ${entry.name}${where}`;
  });
  return [
    "添付素材（ユーザーが「素材N」と書いたら、次の対応表のファイルを指す。画像は画像としても添付されている）:",
    ...lines,
  ].join("\n");
}
