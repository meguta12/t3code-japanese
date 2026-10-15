import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { mediaKindFromPath } from "@t3tools/shared/filePreview";
import { memo, useState } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { LazyChatMedia } from "./LazyChatMedia";

type InlineMediaProps = {
  readonly source: string;
  /** Provider image results can return an HTTPS URL without a filename extension. */
  readonly kind?: "image" | "video" | "audio" | undefined;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly baseDir?: string | undefined;
  readonly label?: string | undefined;
  readonly onImageOpen?: ((src: string) => void) | undefined;
};

/** Inline paths are small, streaming native players; no metadata or media is preloaded. */
export const ChatInlineMedia = memo(function ChatInlineMedia(props: InlineMediaProps) {
  const kind = props.kind ?? mediaKindFromPath(props.source);
  if (kind === null) return null;
  return (
    <LazyChatMedia key={props.source} compact={kind === "audio"}>
      <LoadedInlineMedia {...props} kind={kind} />
    </LazyChatMedia>
  );
});

function LoadedInlineMedia({
  source,
  threadRef,
  baseDir,
  label = source,
  onImageOpen,
  kind,
}: InlineMediaProps & { readonly kind: "image" | "video" | "audio" }) {
  const classified = classifyMarkdownImageSource(source, baseDir);
  const resource =
    classified._tag === "WorkspaceFile" && threadRef
      ? { _tag: "media-file" as const, threadId: threadRef.threadId, path: classified.path }
      : null;
  const asset = useAssetUrlState(threadRef?.environmentId ?? null, resource);
  const src =
    classified._tag === "Direct"
      ? classified.uri
      : resource !== null && asset._tag === "Success"
        ? asset.url
        : null;
  const [failed, setFailed] = useState(false);
  const unavailable =
    failed ||
    classified._tag === "Blocked" ||
    (classified._tag === "WorkspaceFile" && (!threadRef || asset._tag === "Failure"));
  if (src === null || failed) {
    return (
      <span
        role={unavailable ? "alert" : "status"}
        className="inline-flex h-12 max-w-full items-center rounded-md bg-muted/40 px-3 text-xs text-muted-foreground"
      >
        {unavailable ? "メディアを読み込めません" : "メディアを読み込み中"}
      </span>
    );
  }
  if (kind === "audio") {
    return (
      <audio
        src={src}
        controls
        preload="none"
        aria-label={label || "音声プレビュー"}
        className="inline-block h-12 w-80 max-w-full align-middle"
        onError={() => setFailed(true)}
      />
    );
  }
  if (kind === "video") {
    return (
      <video
        src={src}
        controls
        playsInline
        preload="none"
        aria-label={label || "動画プレビュー"}
        className="inline-block max-h-48 w-80 max-w-full rounded-md bg-black object-contain align-middle"
        onError={() => setFailed(true)}
      />
    );
  }
  const image = (
    <img
      src={src}
      alt={label}
      loading="lazy"
      decoding="async"
      className="max-h-48 w-auto max-w-full rounded-md object-contain"
      onError={() => setFailed(true)}
    />
  );
  return onImageOpen ? (
    <button
      type="button"
      aria-label="画像を拡大"
      className="inline-block max-w-80 align-middle"
      onClick={() => onImageOpen(src)}
    >
      {image}
    </button>
  ) : (
    image
  );
}
