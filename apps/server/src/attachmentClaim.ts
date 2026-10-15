// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { reserveAttachmentStorage, releaseAttachmentStorage } from "./attachmentStorage.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** Whether a failure (possibly wrapped in `cause` chains) is the disk being full. */
export function isNoSpaceError(cause: unknown): boolean {
  for (let current = cause, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") {
      return false;
    }
    if ((current as { code?: unknown }).code === "ENOSPC") {
      return true;
    }
    if ((current as { _tag?: unknown })._tag === "AttachmentInsufficientStorageError") {
      return true;
    }
    const reasonMessage = (current as { reason?: { message?: unknown } }).reason?.message;
    if (typeof reasonMessage === "string" && /ENOSPC|no space left/i.test(reasonMessage)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Use copy-on-write clones for large files, with independent copies on other volumes. */
export const ATTACHMENT_CLAIM_CLONE_MIN_BYTES = 64 * 1024 * 1024;

export const cloneOrCopyAttachmentFile = Effect.fn("attachmentClaim.cloneOrCopy")(
  function* (input: {
    readonly fromPath: string;
    readonly toPath: string;
    readonly sizeBytes: number;
    readonly attachmentsDir?: string;
    readonly cloneMinBytes?: number;
    readonly cloneFile?: (from: string, to: string) => Promise<void>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = input.attachmentsDir ?? NodePath.dirname(input.toPath);
    const id = NodeCrypto.randomUUID();
    const copy = Effect.acquireUseRelease(
      reserveAttachmentStorage({
        attachmentsDir: directory,
        sizeBytes: input.sizeBytes,
        id,
        active: true,
      }),
      () =>
        fileSystem.copyFile(input.fromPath, input.toPath).pipe(
          Effect.as("copy" as const),
          Effect.onError(() =>
            fileSystem.remove(input.toPath, { force: true }).pipe(Effect.ignore),
          ),
        ),
      () => releaseAttachmentStorage(directory, id),
    );
    if (input.sizeBytes < (input.cloneMinBytes ?? ATTACHMENT_CLAIM_CLONE_MIN_BYTES))
      return yield* copy;
    return yield* Effect.tryPromise({
      try: () =>
        (
          input.cloneFile ??
          ((from, to) => NodeFSP.copyFile(from, to, NodeFS.constants.COPYFILE_FICLONE_FORCE))
        )(input.fromPath, input.toPath),
      catch: (cause) => cause,
    }).pipe(
      Effect.as("clone" as const),
      Effect.catch(() =>
        fileSystem.remove(input.toPath, { force: true }).pipe(Effect.ignore, Effect.andThen(copy)),
      ),
    );
  },
);
