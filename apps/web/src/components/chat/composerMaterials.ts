import {
  assignMaterialOrdinals,
  findReferenceMaterialLinks,
  materialKindOf,
  type MaterialKind,
} from "@t3tools/shared/attachmentMaterials";

import { useMemo } from "react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";

/** One tile of the composer's 素材 strip. */
export interface ComposerMaterial {
  /** The attachment id, or `ref:<path>` for a file attached by reference. */
  readonly key: string;
  readonly ordinal: number;
  readonly kind: MaterialKind;
  readonly name: string;
  readonly sizeBytes: number | null;
  /** Source for the image thumbnail or the video's first frame. */
  readonly file: File | null;
  /** The upload store has progress or an error for this attachment. */
  readonly trackUpload: boolean;
  /** A reloaded draft file that has to be attached again before it can be sent. */
  readonly needsReattach: boolean;
  readonly notPersisted: boolean;
  readonly referencePath: string | null;
}

export const REFERENCE_MATERIAL_KEY_PREFIX = "ref:";

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path;
}

/**
 * The tiles for the draft's attachments and by-reference files, in number
 * order. A number is only ever missing on an attachment that predates
 * numbering; it then gets the lowest number nothing else holds.
 */
export function buildComposerMaterials(input: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly references: ReadonlyArray<{ readonly ordinal: number; readonly path: string }>;
  readonly nonPersistedImageIds: ReadonlySet<string>;
  readonly trackImageUploads: boolean;
  readonly canUploadFile: (file: ComposerFileAttachment) => boolean;
  readonly isNeedsReattach: (file: ComposerFileAttachment) => boolean;
  readonly referenceSize: (path: string) => number | null;
}): ComposerMaterial[] {
  const sources: Array<{
    ordinal: number | undefined;
    material: Omit<ComposerMaterial, "ordinal">;
  }> = [
    ...input.images.map((image) => ({
      ordinal: image.ordinal,
      material: {
        key: image.id,
        kind: "image" as const,
        name: image.name,
        sizeBytes: image.sizeBytes,
        file: image.file,
        trackUpload: input.trackImageUploads,
        needsReattach: false,
        notPersisted: input.nonPersistedImageIds.has(image.id),
        referencePath: null,
      },
    })),
    ...input.files.map((file) => ({
      ordinal: file.ordinal,
      material: {
        key: file.id,
        kind: file.source?._tag === "pasted-text" ? ("pasted-text" as const) : materialKindOf(file),
        name: file.name,
        sizeBytes: file.sizeBytes,
        file: file.file,
        trackUpload: input.canUploadFile(file),
        needsReattach: input.isNeedsReattach(file),
        notPersisted: false,
        referencePath: null,
      },
    })),
    ...input.references.map((reference) => ({
      ordinal: reference.ordinal,
      material: {
        key: `${REFERENCE_MATERIAL_KEY_PREFIX}${reference.path}`,
        kind: "reference" as const,
        name: basename(reference.path),
        sizeBytes: input.referenceSize(reference.path),
        file: null,
        trackUpload: false,
        needsReattach: false,
        notPersisted: false,
        referencePath: reference.path,
      },
    })),
  ];
  const ordinals = assignMaterialOrdinals(
    [],
    sources.map((source) => source.ordinal),
  );
  return sources
    .map((source, index) => ({ ...source.material, ordinal: ordinals[index]! }))
    .sort((left, right) => left.ordinal - right.ordinal);
}

const EMPTY_LINKS: ReadonlyArray<MaterialLink> = [];

interface MaterialLink {
  readonly ordinal: number;
  readonly path: string;
}

/**
 * The by-reference files whose mention is in the prompt, as a list that keeps
 * its identity while the links stay the same. The prompt changes on every
 * keystroke; the strip must not.
 */
export function useStableMaterialLinks(
  prompt: string | null,
  ordinalByPath: Readonly<Record<string, number>> | undefined,
): ReadonlyArray<MaterialLink> {
  const encoded = useMemo(() => {
    if (prompt === null || ordinalByPath === undefined) return "";
    return findReferenceMaterialLinks(prompt, ordinalByPath)
      .map((link) => `${link.ordinal}\u0000${link.path}`)
      .join("\u0001");
  }, [prompt, ordinalByPath]);
  return useMemo(
    () =>
      encoded === ""
        ? EMPTY_LINKS
        : encoded.split("\u0001").map((entry) => {
            const separator = entry.indexOf("\u0000");
            return { ordinal: Number(entry.slice(0, separator)), path: entry.slice(separator + 1) };
          }),
    [encoded],
  );
}
