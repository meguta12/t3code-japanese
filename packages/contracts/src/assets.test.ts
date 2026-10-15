import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AttachmentCreateUploadUrlInput,
  AttachmentInsufficientStorageError,
  formatAttachmentByteSize,
} from "./assets.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "./orchestration.ts";

const isUploadInput = Schema.is(AttachmentCreateUploadUrlInput);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
} as const;

describe("AttachmentCreateUploadUrlInput", () => {
  it("accepts supported image attachments", () => {
    expect(isUploadInput(uploadInput)).toBe(true);
  });

  it("rejects image types that providers do not support", () => {
    expect(isUploadInput({ ...uploadInput, mimeType: "image/svg+xml" })).toBe(false);
  });

  it("accepts generic files without treating them as provider images", () => {
    expect(
      isUploadInput({
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
      }),
    ).toBe(true);
    expect(
      isUploadInput({
        type: "file",
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        sizeBytes: 3,
      }),
    ).toBe(true);
  });

  it("rejects empty and oversized uploads", () => {
    expect(isUploadInput({ ...uploadInput, sizeBytes: 0 })).toBe(false);
    expect(
      isUploadInput({ ...uploadInput, sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 }),
    ).toBe(false);
    expect(
      isUploadInput({
        type: "file",
        name: "archive.zip",
        mimeType: "application/zip",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      }),
    ).toBe(false);
  });
});

describe("large file uploads", () => {
  const gib = 1024 * 1024 * 1024;

  it("accepts multi-gigabyte files up to exactly 100 GiB", () => {
    for (const sizeBytes of [4 * gib + 1, 50 * gib, 100 * gib]) {
      expect(
        isUploadInput({
          type: "file",
          name: "recording.mov",
          mimeType: "video/quicktime",
          sizeBytes,
        }),
      ).toBe(true);
    }
    expect(PROVIDER_SEND_TURN_MAX_FILE_BYTES).toBe(100 * gib);
  });

  it("keeps the image cap so providers never read oversized image bytes", () => {
    expect(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
    expect(isUploadInput({ ...uploadInput, sizeBytes: 5 * gib })).toBe(false);
  });

  it("formats sizes in binary units", () => {
    expect(formatAttachmentByteSize(100 * gib)).toBe("100 GB");
    expect(formatAttachmentByteSize(1536 * 1024 * 1024)).toBe("1.5 GB");
    expect(formatAttachmentByteSize(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatAttachmentByteSize(1)).toBe("1 KB");
  });

  it("explains a full disk with required and available sizes", () => {
    const error = new AttachmentInsufficientStorageError({
      requiredBytes: 20 * gib,
      availableBytes: 3 * gib,
    });
    expect(error.message).toContain("20 GB");
    expect(error.message).toContain("3 GB");
  });
});
