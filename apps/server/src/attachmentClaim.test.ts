// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AttachmentInsufficientStorageError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import {
  ATTACHMENT_CLAIM_CLONE_MIN_BYTES,
  isNoSpaceError,
  cloneOrCopyAttachmentFile,
} from "./attachmentClaim.ts";

const withTempDir = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claim-"))),
    use,
    (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );

const failing = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    description: `${method} failed`,
  });

describe("cloneOrCopyAttachmentFile", () => {
  it.effect("clones large files without sharing mutable inode contents", () =>
    withTempDir((directory) =>
      Effect.gen(function* () {
        const from = NodePath.join(directory, "pending.mov");
        const to = NodePath.join(directory, "thread.mov");
        NodeFS.writeFileSync(from, "video");

        const how = yield* cloneOrCopyAttachmentFile({
          fromPath: from,
          toPath: to,
          sizeBytes: ATTACHMENT_CLAIM_CLONE_MIN_BYTES,
        });

        expect(["clone", "copy"]).toContain(how);
        expect(NodeFS.statSync(to).ino).not.toBe(NodeFS.statSync(from).ino);
        NodeFS.writeFileSync(to, "changed");
        expect(NodeFS.readFileSync(from, "utf8")).toBe("video");
        // The pending name survives, so a failed bootstrap can still retry.
        NodeFS.unlinkSync(from);
        expect(NodeFS.readFileSync(to, "utf8")).toBe("changed");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("keeps an independent copy for small files", () =>
    withTempDir((directory) =>
      Effect.gen(function* () {
        const from = NodePath.join(directory, "pending.txt");
        const to = NodePath.join(directory, "thread.txt");
        NodeFS.writeFileSync(from, "notes");

        const how = yield* cloneOrCopyAttachmentFile({ fromPath: from, toPath: to, sizeBytes: 5 });

        expect(how).toBe("copy");
        expect(NodeFS.statSync(to).ino).not.toBe(NodeFS.statSync(from).ino);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("falls back to an independent copy when the volume cannot clone", () =>
    withTempDir((directory) =>
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem;
        const from = NodePath.join(directory, "pending.mov");
        const to = NodePath.join(directory, "thread.mov");
        NodeFS.writeFileSync(from, "video");

        const how = yield* cloneOrCopyAttachmentFile({
          fromPath: from,
          toPath: to,
          sizeBytes: ATTACHMENT_CLAIM_CLONE_MIN_BYTES,
          cloneFile: () => Promise.reject(new Error("clone unsupported")),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...real,
            link: () => Effect.fail(failing("link")),
          }),
        );

        expect(how).toBe("copy");
        expect(NodeFS.readFileSync(to, "utf8")).toBe("video");
        expect(NodeFS.statSync(to).ino).not.toBe(NodeFS.statSync(from).ino);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("checks storage before a failed clone falls back to copying", () =>
    withTempDir((directory) =>
      Effect.gen(function* () {
        const from = NodePath.join(directory, "pending.mov");
        const to = NodePath.join(directory, "thread.mov");
        NodeFS.writeFileSync(from, "video");
        const failure = yield* cloneOrCopyAttachmentFile({
          fromPath: from,
          toPath: to,
          sizeBytes: Number.MAX_SAFE_INTEGER,
          cloneFile: () => Promise.reject(new Error("unsupported clone")),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("AttachmentInsufficientStorageError");
        expect(NodeFS.existsSync(to)).toBe(false);
        expect(NodeFS.readFileSync(from, "utf8")).toBe("video");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("removes a half-written copy when copying fails", () =>
    withTempDir((directory) =>
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem;
        const from = NodePath.join(directory, "pending.txt");
        const to = NodePath.join(directory, "thread.txt");
        NodeFS.writeFileSync(from, "notes");

        const failure = yield* cloneOrCopyAttachmentFile({
          fromPath: from,
          toPath: to,
          sizeBytes: 5,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...real,
            copyFile: () =>
              Effect.sync(() => NodeFS.writeFileSync(to, "no")).pipe(
                Effect.andThen(Effect.fail(failing("copyFile"))),
              ),
          }),
          Effect.flip,
        );

        expect(failure._tag).toBe("PlatformError");
        expect(NodeFS.existsSync(to)).toBe(false);
        expect(NodeFS.existsSync(from)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});

describe("isNoSpaceError", () => {
  it("finds ENOSPC anywhere in a cause chain", () => {
    expect(isNoSpaceError(Object.assign(new Error("write"), { code: "ENOSPC" }))).toBe(true);
    expect(isNoSpaceError({ reason: { message: "ENOSPC: no space left on device" } })).toBe(true);
    expect(isNoSpaceError({ cause: { cause: { code: "ENOSPC" } } })).toBe(true);
    expect(
      isNoSpaceError(
        new AttachmentInsufficientStorageError({ requiredBytes: 1000, availableBytes: 1 }),
      ),
    ).toBe(true);
    expect(isNoSpaceError(new Error("EACCES"))).toBe(false);
    expect(isNoSpaceError(undefined)).toBe(false);
  });
});
