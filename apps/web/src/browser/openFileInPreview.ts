import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  rememberPreviewUrl,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "./browserDefaults";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export class BrowserSettingsReadError extends Data.TaggedError("BrowserSettingsReadError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "Saved browser settings could not be loaded.";
  }
}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (defaults instanceof BrowserSettingsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      url: input.url,
      // Built here rather than via `openPreviewSession` because this path
      // maps the result differently, so the configured defaults have to be
      // applied explicitly or file/link opens would ignore them.
      viewport: browserDefaultOpenViewport(defaults),
      profileId: browserDefaultOpenProfileId(defaults),
    },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    rememberPreviewUrl(input.threadRef, input.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

/**
 * Opens a signed document in the integrated browser, or a separate tab on web.
 * Reserve the web tab during the user gesture so signing does not trigger a popup block.
 */
export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<
  AtomCommandResult<
    void,
    AssetError | PreviewError | BrowserPreviewUnavailableError | BrowserSettingsReadError
  >
> {
  const integrated = isPreviewSupportedInRuntime();
  const browserTab = integrated ? null : reserveBrowserPreviewTab();
  if (!integrated && browserTab === null) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message:
            "プレビュー用のタブを開けませんでした。ブラウザのポップアップを許可してください。",
        }),
      ),
    );
  }
  try {
    const insideWorkspace =
      mediaFileReference(input.filePath, input.workspaceRoot).relativePath !== undefined;
    const assetResult = await input.createAssetUrl({
      environmentId: input.threadRef.environmentId,
      input: {
        resource: {
          _tag: insideWorkspace ? "workspace-file" : "media-file",
          threadId: input.threadRef.threadId,
          path: input.filePath,
        },
      },
    });
    if (assetResult._tag === "Failure") {
      browserTab?.close();
      return AsyncResult.failure(assetResult.cause);
    }
    const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
    if (assetUrl === null || !/^https?:\/\//i.test(assetUrl)) {
      browserTab?.close();
      return AsyncResult.failure(
        Cause.die(new Error("環境から無効なプレビューURLが返されました。")),
      );
    }
    if (browserTab) {
      browserTab.navigate(assetUrl);
      return AsyncResult.success(undefined);
    }
    return openUrlInPreview({
      threadRef: input.threadRef,
      url: assetUrl,
      openPreview: input.openPreview,
    });
  } catch (cause) {
    browserTab?.close();
    return AsyncResult.failure(Cause.die(cause));
  }
}

function reserveBrowserPreviewTab(): {
  readonly navigate: (url: string) => void;
  readonly close: () => void;
} | null {
  if (typeof window === "undefined") return null;
  const tab = window.open("about:blank", "_blank");
  if (!tab) return null;
  // The blank document is trusted and synchronous; cut its opener before signing starts.
  tab.opener = null;
  return {
    navigate: (url) => {
      const link = tab.document.createElement("a");
      link.href = url;
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      tab.document.body.append(link);
      link.click();
      link.remove();
    },
    close: () => tab.close(),
  };
}
