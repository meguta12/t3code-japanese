// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import { AttachmentInsufficientStorageError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export const ATTACHMENT_STORAGE_RESERVE_BYTES = 512 * 1024 * 1024;

export const readAttachmentVolumeFreeBytes = (directory: string) =>
  Effect.promise(async () => {
    try {
      await NodeFSP.mkdir(directory, { recursive: true });
      const stats = await NodeFSP.statfs(directory, { bigint: true });
      return Number(stats.bavail * stats.bsize);
    } catch {
      return null;
    }
  });

type Reservation = { bytes: number; expiresAt: number; active: boolean };
const reservations = new Map<string, Map<string, Reservation>>();

interface StorageInput {
  readonly attachmentsDir: string;
  readonly sizeBytes: number;
  readonly readFreeBytes?: (directory: string) => Effect.Effect<number | null>;
}

const availableStorage = Effect.fnUntraced(function* (input: StorageInput) {
  const freeBytes = yield* (input.readFreeBytes ?? readAttachmentVolumeFreeBytes)(
    input.attachmentsDir,
  );
  const now = yield* Clock.currentTimeMillis;
  const entries = reservations.get(input.attachmentsDir) ?? new Map<string, Reservation>();
  for (const [id, entry] of entries) {
    if (!entry.active && entry.expiresAt <= now) entries.delete(id);
  }
  reservations.set(input.attachmentsDir, entries);
  return { freeBytes, entries };
});

export const ensureAttachmentStorageHasRoom = Effect.fnUntraced(function* (input: StorageInput) {
  const { freeBytes, entries } = yield* availableStorage(input);
  if (freeBytes === null) return;
  const reserved = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0);
  const usable = Math.max(0, freeBytes - ATTACHMENT_STORAGE_RESERVE_BYTES - reserved);
  if (input.sizeBytes > usable) {
    return yield* new AttachmentInsufficientStorageError({
      requiredBytes: input.sizeBytes,
      availableBytes: usable,
    });
  }
});

/** Reserve before admitting bytes; commit admission synchronously after reading the volume. */
export const reserveAttachmentStorage = Effect.fnUntraced(function* (
  input: StorageInput & {
    readonly id: string;
    readonly expiresAt?: number;
    readonly active?: boolean;
  },
) {
  const { freeBytes, entries } = yield* availableStorage(input);
  const previous = entries.get(input.id);
  if (previous?.active && input.active) {
    return yield* new AttachmentInsufficientStorageError({
      requiredBytes: input.sizeBytes,
      availableBytes: 0,
    });
  }
  const reserved = [...entries.entries()].reduce(
    (total, [id, entry]) => total + (id === input.id ? 0 : entry.bytes),
    0,
  );
  const usable =
    freeBytes === null
      ? null
      : Math.max(0, freeBytes - ATTACHMENT_STORAGE_RESERVE_BYTES - reserved);
  if (usable !== null && input.sizeBytes > usable) {
    return yield* new AttachmentInsufficientStorageError({
      requiredBytes: input.sizeBytes,
      availableBytes: usable,
    });
  }
  entries.set(input.id, {
    bytes: input.sizeBytes,
    expiresAt: input.expiresAt ?? Number.POSITIVE_INFINITY,
    active: input.active ?? false,
  });
});

export const releaseAttachmentStorage = (
  attachmentsDir: string,
  id: string,
  onlyInactive = false,
) =>
  Effect.sync(() => {
    const entries = reservations.get(attachmentsDir);
    // Deleting a pending token cannot release capacity still owned by its writer.
    if (onlyInactive && entries?.get(id)?.active) return;
    entries?.delete(id);
    if (entries?.size === 0) reservations.delete(attachmentsDir);
  });
