import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { MATERIAL_KIND_LABEL, formatMaterialName } from "@t3tools/shared/attachmentMaterials";
import {
  CircleAlertIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  LinkIcon,
  MusicIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useState, type ReactNode } from "react";

import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { formatAttachmentUploadProgress } from "../../lib/attachmentUploadState";
import { ja, jaTemplate } from "../../lib/ja";
import { RefreshIcon } from "../ui/refresh-icon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerMaterial } from "./composerMaterials";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { attachVideoThumbnail } from "./ExpandedImagePreview";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";

export interface ComposerMaterialActions {
  /** Opens the preview for an attachment tile. */
  readonly open: (key: string) => void;
  /** Takes the attachment out of the draft; for a reference, takes its mention out of the text. */
  readonly remove: (key: string) => void;
  readonly retry: (key: string) => void;
  /** Puts 「素材N 」 at the editor cursor. */
  readonly insert: (ordinal: number) => void;
}

/** First frame of a video, decoded from the local File. */
function MaterialVideoFrame({ file }: { file: File }) {
  const setVideo = useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video) return;
      return attachVideoThumbnail(video, file);
    },
    [file],
  );
  return (
    <video
      ref={setVideo}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
      className="pointer-events-none absolute inset-0 size-full object-cover"
    />
  );
}

/**
 * True once the tile has scrolled near the viewport. A strip of twenty clips
 * must not decode twenty thumbnails up front, so previews mount on first sight
 * and then stay.
 */
function useHasBeenVisible() {
  const [visible, setVisible] = useState(false);
  const ref = useCallback(
    (node: HTMLElement | null) => {
      if (!node || visible) return;
      if (typeof IntersectionObserver === "undefined") {
        setVisible(true);
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
        },
        { rootMargin: "0px 192px" },
      );
      observer.observe(node);
      return () => observer.disconnect();
    },
    [visible],
  );
  return [ref, visible] as const;
}

const KIND_ICON_CLASS = "size-6 text-secondary-label";

function MaterialKindIcon({ kind }: { kind: ComposerMaterial["kind"] }) {
  switch (kind) {
    case "image":
      return <ImageIcon className={KIND_ICON_CLASS} />;
    case "video":
      return <VideoIcon className={KIND_ICON_CLASS} />;
    case "audio":
      return <MusicIcon className={KIND_ICON_CLASS} />;
    case "pdf":
    case "pasted-text":
      return <FileTextIcon className={KIND_ICON_CLASS} />;
    case "reference":
      return <LinkIcon className={KIND_ICON_CLASS} />;
    case "file":
      return <FileIcon className={KIND_ICON_CLASS} />;
  }
}

/** The number in a tile's top-left corner; pressing it writes 「素材N」 into the text. */
export function MaterialNumberBadge({
  ordinal,
  onInsert,
}: {
  ordinal: number;
  onInsert: (ordinal: number) => void;
}) {
  const label = `${formatMaterialName(ordinal)} をメッセージに入れる`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-composer-material-number={ordinal}
            aria-label={label}
            className="absolute left-1 top-1 z-10 flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md bg-foreground px-1.5 font-bold text-background text-sm tabular-nums leading-none shadow-sm outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onInsert(ordinal)}
          />
        }
      >
        {ordinal}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

const ComposerMaterialTile = memo(function ComposerMaterialTile({
  material,
  actions,
}: {
  material: ComposerMaterial;
  actions: ComposerMaterialActions;
}) {
  const [previewRef, visible] = useHasBeenVisible();
  // Only this tile re-renders when its own upload moves.
  const upload = useAttachmentUploadStore((state) =>
    material.trackUpload ? state.uploadsByImageId[material.key] : undefined,
  );
  const label = formatMaterialName(material.ordinal);
  const isReference = material.referencePath !== null;
  const canOpen = !isReference && !material.needsReattach;
  const detail = material.needsReattach
    ? ja("Attach again")
    : upload?.status === "uploading"
      ? formatAttachmentUploadProgress(upload.progress)
      : [
          MATERIAL_KIND_LABEL[material.kind],
          material.sizeBytes === null ? null : formatAttachmentSize(material.sizeBytes),
        ]
          .filter((part) => part !== null)
          .join(" · ");

  let preview: ReactNode = <MaterialKindIcon kind={material.kind} />;
  if (visible && material.file !== null) {
    if (material.kind === "image") {
      preview = (
        <ComposerImageThumbnail
          file={material.file}
          alt=""
          className="size-full object-cover"
          fallback={<MaterialKindIcon kind={"image"} />}
        />
      );
    } else if (material.kind === "video") {
      preview = (
        <>
          <MaterialKindIcon kind="video" />
          <MaterialVideoFrame file={material.file} />
        </>
      );
    }
  }
  const previewBody = (
    <span className="relative flex size-full items-center justify-center overflow-hidden">
      {preview}
    </span>
  );

  return (
    <div
      data-composer-material={material.ordinal}
      className="group/material relative flex w-26 shrink-0 snap-start flex-col overflow-hidden rounded-lg border border-border/80 bg-background"
    >
      <div ref={previewRef} className="relative h-16 w-full bg-muted/50">
        {canOpen ? (
          <button
            type="button"
            className="size-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            aria-label={jaTemplate`Preview ${material.name}`}
            onClick={() => actions.open(material.key)}
          >
            {previewBody}
          </button>
        ) : (
          previewBody
        )}
        {upload?.status === "uploading" && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
            {formatAttachmentUploadProgress(upload.progress)}
          </span>
        )}
        {upload?.status === "failed" && !material.needsReattach && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="overlay"
                  size="icon-xs"
                  className="absolute bottom-1 left-1"
                  onClick={() => actions.retry(material.key)}
                  aria-label={jaTemplate`Retry upload for ${material.name}`}
                />
              }
            >
              <RefreshIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">{upload.reason}</TooltipPopup>
          </Tooltip>
        )}
        {material.notPersisted && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  aria-label={ja("Draft attachment may not persist")}
                  className="absolute bottom-1 right-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-warning-foreground"
                >
                  <CircleAlertIcon className="size-3" />
                </span>
              }
            />
            <TooltipPopup side="top">
              添付ファイルの下書きを保存できませんでした。画面を移動すると失われる可能性があります。
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={<div className="flex min-w-0 flex-col gap-0.5 px-1.5 py-1 text-left" />}
        >
          <span className="truncate text-xs leading-tight text-foreground">{material.name}</span>
          <span className="truncate text-3xs leading-tight text-secondary-label tabular-nums">
            {detail}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top" className="whitespace-pre-line break-all">
          {material.referencePath ?? material.name}
        </TooltipPopup>
      </Tooltip>
      <MaterialNumberBadge ordinal={material.ordinal} onInsert={actions.insert} />
      <Button
        variant="media-close"
        size="icon-xs"
        className="absolute right-1 top-1"
        onClick={() => actions.remove(material.key)}
        aria-label={
          isReference
            ? `${label} ${material.name} をメッセージから外す`
            : `${label} ${material.name} を削除`
        }
      >
        <XIcon />
      </Button>
    </div>
  );
});

/**
 * The numbered tiles of the composer's 素材 strip. Rendered inside the strip's
 * scroll row; memoized so typing in the editor never reconciles them.
 */
export const ComposerMaterialTiles = memo(function ComposerMaterialTiles({
  materials,
  actions,
}: {
  materials: ReadonlyArray<ComposerMaterial>;
  actions: ComposerMaterialActions;
}) {
  return (
    <>
      {materials.map((material) => (
        <ComposerMaterialTile key={material.key} material={material} actions={actions} />
      ))}
    </>
  );
});
