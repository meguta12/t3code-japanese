export type ComposerInlineToken =
  | {
      readonly type: "mention";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: "skill";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    };

export interface CollectComposerInlineTokensOptions {
  readonly preserveTrailingFrom?: ReadonlyArray<ComposerInlineToken>;
}

/**
 * A skill name may start with a digit, but compact monetary amounts and
 * numeric expressions like "$20", "$20k", "$100M", and "$1e6" must stay prose:
 * the composer chips any matched `$name` token, known or not. Tokens beginning
 * with digits must not match numbers with currency/exponent suffixes, and must
 * contain at least one letter.
 */
const SKILL_TOKEN_REGEX =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s)/gu;
const MENTION_TOKEN_REGEX = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;
/**
 * The label body is bounded rather than `*`. Unbounded, every whitespace in
 * the composer is a candidate start: the engine scans the rest of the text for
 * a closing `]`, fails, and rescans from the next whitespace — quadratic on
 * input like " [[[[[…". A cap makes each attempt constant-bounded.
 *
 * Only a basename ever survives the `label !== basename` check below, so this
 * cannot reject a link a user could meaningfully write; the longest filename
 * any common filesystem allows is 255.
 */
const MAX_FILE_LINK_LABEL_LENGTH = 512;
const FILE_LINK_TOKEN_REGEX = new RegExp(
  `(^|\\s)\\[((?:\\\\.|[^\\]\\\\]){0,${MAX_FILE_LINK_LABEL_LENGTH}})\\]\\(([^)\\s]+)\\)(?=\\s)`,
  "g",
);
/**
 * A file attached by reference carries its material number in the link label
 * ("[素材4 clip.mov](/path/clip.mov)") when the message is sent, so the
 * provider prompt can tie "素材4" to the path. The label otherwise stays the
 * basename.
 */
const MATERIAL_LABEL_PREFIX_REGEX = /^素材([1-9][0-9]{0,3}) /;

/** Splits a "素材N " prefix off a file link label. */
export function splitMaterialLabel(label: string): {
  readonly ordinal: number | null;
  readonly name: string;
} {
  const match = MATERIAL_LABEL_PREFIX_REGEX.exec(label);
  return match
    ? { ordinal: Number(match[1]), name: label.slice(match[0].length) }
    : { ordinal: null, name: label };
}

const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
// Autocomplete emits canonical file links, so ambiguous bare @scope/package text stays a package.
const SCOPED_PACKAGE_REFERENCE_REGEX =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[^\s@"]+)*$/;

function collectMentionTokens(text: string): ComposerInlineToken[] {
  const matches: ComposerInlineToken[] = [];

  for (const match of text.matchAll(FILE_LINK_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const label = (match[2] ?? "").replace(/\\(.)/g, "$1");
    const encodedPath = match[3] ?? "";
    let path = encodedPath;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      // Preserve malformed source rather than dropping a user-authored token.
    }
    const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const basename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
    const hasExternalScheme = URI_SCHEME_REGEX.test(path) && !WINDOWS_DRIVE_PATH_REGEX.test(path);
    if (
      !path ||
      hasExternalScheme ||
      (label !== basename && splitMaterialLabel(label).name !== basename)
    ) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "mention",
      value: path,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const quotedPath = match[2];
    const path = quotedPath !== undefined ? quotedPath.replace(/\\(.)/g, "$1") : (match[3] ?? "");
    if (!path || (quotedPath === undefined && SCOPED_PACKAGE_REFERENCE_REGEX.test(path))) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "mention",
      value: path,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  return matches;
}

export function collectComposerInlineTokens(
  text: string,
  options: CollectComposerInlineTokensOptions = {},
): ReadonlyArray<ComposerInlineToken> {
  const matches = collectMentionTokens(text);

  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const value = match[2] ?? "";
    if (!value) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "skill",
      value,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const token of options.preserveTrailingFrom ?? []) {
    if (
      token.end === text.length &&
      text.slice(token.start, token.end) === token.source &&
      !matches.some(
        (match) =>
          match.type === token.type && match.start === token.start && match.end === token.end,
      )
    ) {
      matches.push(token);
    }
  }

  return [...matches].sort((left, right) => left.start - right.start);
}

/**
 * Composer file links percent-encode their destination, so a Japanese or
 * spaced path reaches the provider as `%E5%8B%95...`. A model that opens that
 * literally gets a missing file, so the provider copy of an absolute-path link
 * carries the real path in an angle-bracket destination (valid CommonMark,
 * spaces allowed). Relative links and `@path` mentions are left untouched.
 */
export function expandComposerFileLinksForProvider(input: string): string {
  // Tokens need a following whitespace, and a sent prompt is trimmed: a link
  // that ends the message would otherwise stay encoded.
  const prompt = `${input}\n`;
  let text = "";
  let cursor = 0;
  for (const token of collectComposerInlineTokens(prompt)) {
    if (token.type !== "mention" || !token.source.startsWith("[") || token.start < cursor) continue;
    const isAbsolute =
      token.value.startsWith("/") ||
      token.value.startsWith("\\\\") ||
      WINDOWS_DRIVE_PATH_REGEX.test(token.value);
    if (!isAbsolute || /[<>\r\n]/.test(token.value)) continue;
    const labelEnd = token.source.lastIndexOf("](");
    if (labelEnd < 0) continue;
    text += `${prompt.slice(cursor, token.start)}${token.source.slice(0, labelEnd)}](<${token.value}>)`;
    cursor = token.end;
  }
  return cursor === 0 ? input : (text + prompt.slice(cursor)).slice(0, -1);
}
