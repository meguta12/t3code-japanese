import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { mediaKindFromPath } from "@t3tools/shared/filePreview";

export const MAX_INLINE_MEDIA_PER_MESSAGE = 6;

/** Commands and ambiguous whitespace stay code; authored host paths can contain spaces. */
export function inlineMediaPathCandidate(value: string): string | null {
  const source = value.trim();
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) return null;
  }
  if (mediaKindFromPath(source) === null) return null;
  if (/\s/.test(source) && !/^(?:\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|file:)/i.test(source))
    return null;
  return classifyMarkdownImageSource(source, "/workspace")._tag === "Blocked" ? null : source;
}

/** Links only complete media tokens; leaves prose punctuation and non-media code untouched. */
export function bareMediaPathParts(value: string): Array<{ text: string; source?: string }> {
  const parts: Array<{ text: string; source?: string }> = [];
  let cursor = 0;
  for (const match of value.matchAll(/[^\s()[\]<>`"'「」『』、。]+/g)) {
    const token = match[0].replace(/[.,;:!?]+$/, "");
    const source = inlineMediaPathCandidate(token);
    if (!source) continue;
    const start = match.index;
    if (start > cursor) parts.push({ text: value.slice(cursor, start) });
    parts.push({ text: token, source });
    cursor = start + token.length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor) });
  return parts;
}
