import type { ProviderOutputMedia, ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Predicate } from "effect";
import type { FileSystem } from "effect/FileSystem";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const OMITTED = "画像データはファイルとして保存しました";
const UNAVAILABLE = "画像データを保存できませんでした";
const imageExtensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

function imageMimeType(bytes: Uint8Array): string | undefined {
  const header = Buffer.from(bytes.subarray(0, 16));
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (header.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  if (
    header.toString("ascii", 4, 8) === "ftyp" &&
    /^(avif|avis)$/.test(header.toString("ascii", 8, 12))
  )
    return "image/avif";
  return undefined;
}

function mediaPath(value: unknown): string | undefined {
  if (!Predicate.isString(value) || value.length > 4096 || /[\r\n\0]/.test(value)) return;
  const trimmed = value.trim();
  if (/^(?:\/|[a-z]:[\\/]|~\/)/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!url.username && !url.password) return url.href;
    } catch {
      return;
    }
  }
}

/** Normalize before queueing so raw events, persisted activities and snapshots stay small. */
export function makeProviderOutputMediaNormalizer(dependencies: {
  readonly fileSystem: FileSystem;
  readonly attachmentsDir: string;
}) {
  // Claude emits updated/completed with the same result object. Weak keys avoid
  // retaining binary provider payloads while reusing their normalized output.
  const normalizedRoots = new WeakMap<
    object,
    {
      readonly value: unknown;
      readonly images: ReadonlyArray<ProviderOutputMedia>;
      readonly failed: boolean;
    }
  >();
  return Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
    const lifecycle =
      event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed";

    const images: ProviderOutputMedia[] = [];
    const paths = new Set<string>();
    const cached = new Map<string, ProviderOutputMedia | undefined>();
    const visited = new WeakMap<object, unknown>();
    let remainingNodes = 10_000;
    let failedToStoreImage = false;
    const addImage = (image: ProviderOutputMedia | undefined) => {
      if (image && images.length < MAX_IMAGES && !paths.has(image.path)) {
        paths.add(image.path);
        images.push(image);
      }
      return image;
    };
    const saveImage = Effect.fnUntraced(function* (
      encoded: string,
      declaredMime?: string,
    ): Effect.fn.Return<ProviderOutputMedia | undefined> {
      if (cached.has(encoded)) return cached.get(encoded);
      if (images.length >= MAX_IMAGES || encoded.length > MAX_BASE64_LENGTH + 128) return;
      const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(encoded);
      const mimeHint = match?.[1]?.toLowerCase() ?? declaredMime?.toLowerCase();
      const base64 = match ? encoded.slice(match[0].length) : encoded;
      if (
        base64.length === 0 ||
        base64.length > MAX_BASE64_LENGTH ||
        base64.length % 4 === 1 ||
        (base64.endsWith("=") && base64.length % 4 !== 0) ||
        !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64)
      )
        return;
      const bytes = Buffer.from(base64, "base64");
      const mimeType = imageMimeType(bytes);
      if (bytes.length > MAX_IMAGE_BYTES || !mimeType || (mimeHint && mimeHint !== mimeType))
        return;
      const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const directory = NodePath.join(dependencies.attachmentsDir, "provider-media");
      const path = NodePath.join(directory, `${digest}.${imageExtensions[mimeType]}`);
      const stored = yield* Effect.gen(function* () {
        yield* dependencies.fileSystem.makeDirectory(directory, { recursive: true });
        // Exclusive create prevents duplicate writes when the SDK repeats output.
        yield* dependencies.fileSystem
          .writeFile(path, bytes, { flag: "wx", mode: 0o600 })
          .pipe(
            Effect.catch((error) =>
              error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
            ),
          );
        return { type: "image" as const, path, mimeType };
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      cached.set(encoded, stored);
      return addImage(stored);
    });

    const normalize = Effect.fnUntraced(function* (
      value: unknown,
      depth: number,
    ): Effect.fn.Return<unknown> {
      if (depth > 16 || --remainingNodes < 0) return "データを省略しました";
      if (Predicate.isString(value) && /^data:image\//i.test(value)) {
        const stored = yield* saveImage(value);
        if (!stored && images.length < MAX_IMAGES) failedToStoreImage = true;
        return stored ?? UNAVAILABLE;
      }
      if (!Array.isArray(value) && !Predicate.isObject(value)) return value;
      if (visited.has(value)) return visited.get(value);
      if (Array.isArray(value)) {
        const result: unknown[] = [];
        visited.set(value, result);
        for (const part of value) result.push(yield* normalize(part, depth + 1));
        return result;
      }

      const record = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      visited.set(value, result);
      const source = Predicate.isObject(record.source) ? record.source : undefined;
      const generated = record.type === "imageGeneration";
      const imageBlock = record.type === "image";
      const savedPath = generated
        ? (mediaPath(record.savedPath) ?? mediaPath(record.result))
        : imageBlock
          ? mediaPath(record.path ?? (source?.type === "file" ? source.path : undefined))
          : undefined;
      if (savedPath) addImage({ type: "image", path: savedPath });
      const encoded = generated
        ? record.result
        : imageBlock
          ? source?.type === "base64"
            ? source.data
            : record.data
          : undefined;
      const declaredMime = source?.media_type ?? record.mimeType ?? record.mime_type;
      const stored =
        Predicate.isString(encoded) && !savedPath
          ? yield* saveImage(encoded, Predicate.isString(declaredMime) ? declaredMime : undefined)
          : undefined;
      if (
        Predicate.isString(encoded) &&
        encoded.length > 0 &&
        !savedPath &&
        !stored &&
        images.length < MAX_IMAGES
      )
        failedToStoreImage = true;
      const url = imageBlock
        ? mediaPath(
            record.imageUrl ??
              record.image_url ??
              record.url ??
              (source?.type === "url" ? source.url : undefined),
          )
        : undefined;
      if (url) addImage({ type: "image", path: url });

      for (const [key, part] of Object.entries(record)) {
        if ((generated && key === "result") || (imageBlock && key === "data")) {
          result[key] = savedPath ?? stored?.path ?? UNAVAILABLE;
        } else if (imageBlock && key === "source" && source?.type === "base64") {
          result[key] = stored
            ? { type: "file", path: stored.path, media_type: stored.mimeType }
            : UNAVAILABLE;
        } else {
          result[key] = yield* normalize(part, depth + 1);
        }
      }
      if (stored || savedPath) result.imageData = OMITTED;
      return result;
    });

    const normalizeRoot = Effect.fnUntraced(function* (value: unknown) {
      const existing = Predicate.isObject(value) ? normalizedRoots.get(value) : undefined;
      if (existing) {
        for (const image of existing.images) addImage(image);
        failedToStoreImage ||= existing.failed;
        return existing.value;
      }
      const result = yield* normalize(value, 0);
      if (Predicate.isObject(value))
        normalizedRoots.set(value, {
          value: result,
          images: [...images],
          failed: failedToStoreImage,
        });
      return result;
    });
    const data = lifecycle ? yield* normalizeRoot(event.payload.data) : undefined;
    // A Claude user envelope can contain results for several parallel tools.
    // Only this item's data owns visible outputs; raw is sanitized separately.
    const outputMedia = [...images];
    const outputStorageFailed = failedToStoreImage;
    const rawPayload = yield* normalizeRoot(event.raw?.payload);
    if (!lifecycle) {
      return {
        ...event,
        ...(event.raw ? { raw: { ...event.raw, payload: rawPayload } } : {}),
      } satisfies ProviderRuntimeEvent;
    }
    return {
      ...event,
      payload: {
        ...event.payload,
        ...(event.payload.data !== undefined ? { data } : {}),
        ...(outputMedia.length > 0 ? { outputMedia } : {}),
        ...(outputStorageFailed
          ? {
              detail: event.payload.detail
                ? `${UNAVAILABLE}\n${event.payload.detail}`
                : UNAVAILABLE,
            }
          : {}),
      },
      ...(event.raw ? { raw: { ...event.raw, payload: rawPayload } } : {}),
    } satisfies ProviderRuntimeEvent;
  });
}
