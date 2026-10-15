import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  ATTACHMENT_STORAGE_RESERVE_BYTES,
  releaseAttachmentStorage,
  reserveAttachmentStorage,
} from "./attachmentStorage.ts";

describe("attachment storage reservations", () => {
  const sizeBytes = 1000;
  const roomForOne = () => Effect.succeed(ATTACHMENT_STORAGE_RESERVE_BYTES + sizeBytes);

  it.effect("admits only one of two concurrent uploads that individually fit", () =>
    Effect.gen(function* () {
      const attachmentsDir = "/concurrent-reservations";
      const input = { attachmentsDir, sizeBytes, readFreeBytes: roomForOne, active: true };
      const results = yield* Effect.all(
        [
          reserveAttachmentStorage({ ...input, id: "one" }).pipe(Effect.result),
          reserveAttachmentStorage({ ...input, id: "two" }).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
      yield* releaseAttachmentStorage(attachmentsDir, "one");
      yield* releaseAttachmentStorage(attachmentsDir, "two");
      yield* reserveAttachmentStorage({ ...input, id: "three" });
      yield* releaseAttachmentStorage(attachmentsDir, "three");
    }),
  );

  it.effect("expires unused upload URLs but retains active transfers", () =>
    Effect.gen(function* () {
      const attachmentsDir = "/expiry-reservations";
      const input = { attachmentsDir, sizeBytes, readFreeBytes: roomForOne };
      yield* reserveAttachmentStorage({ ...input, id: "unused", expiresAt: 1000 });
      yield* TestClock.adjust(1001);
      yield* reserveAttachmentStorage({ ...input, id: "active", active: true, expiresAt: 2000 });
      yield* TestClock.adjust(2000);
      const failure = yield* reserveAttachmentStorage({ ...input, id: "other" }).pipe(Effect.flip);
      expect(failure._tag).toBe("AttachmentInsufficientStorageError");
      yield* releaseAttachmentStorage(attachmentsDir, "active");
    }),
  );

  it.effect("keeps an active writer's reservation when its pending token is deleted", () =>
    Effect.gen(function* () {
      const attachmentsDir = "/delete-active-reservation";
      const input = { attachmentsDir, sizeBytes, readFreeBytes: roomForOne };
      yield* reserveAttachmentStorage({ ...input, id: "writing", active: true });
      yield* releaseAttachmentStorage(attachmentsDir, "writing", true);
      const failure = yield* reserveAttachmentStorage({ ...input, id: "other" }).pipe(Effect.flip);
      expect(failure._tag).toBe("AttachmentInsufficientStorageError");
      yield* releaseAttachmentStorage(attachmentsDir, "writing");
      yield* reserveAttachmentStorage({ ...input, id: "other" });
      yield* releaseAttachmentStorage(attachmentsDir, "other", true);
    }),
  );
});
