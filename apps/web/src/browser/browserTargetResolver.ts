import type {
  AssetCreateUrlResult,
  AssetResource,
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import { readPreparedConnection } from "~/state/session";

export {
  normalizeHostname,
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isPublicFaviconHost,
} from "@t3tools/shared/hostClassification";

const readEnvironmentUrl = (environmentId: EnvironmentId): URL => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return new URL(connection.httpBaseUrl);
};

const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  environmentUrl: URL,
  requestedUrl?: string,
  sourceUrl?: URL,
): PreviewUrlResolution => {
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error(
      "This environment port needs the planned authenticated preview gateway; its server address is not directly private-network reachable.",
    );
  }
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  // Local loopback environments should advertise `localhost` so Chromium
  // dual-stack lookup can reach a Vite server bound only to ::1 or 127.0.0.1.
  const resolvedHost = isLocalLoopbackHost(normalizedEnvironmentHost)
    ? "localhost"
    : normalizedEnvironmentHost.includes(":")
      ? `[${normalizedEnvironmentHost}]`
      : normalizedEnvironmentHost;
  const resolved = sourceUrl
    ? new URL(sourceUrl)
    : new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  if (sourceUrl) {
    resolved.hostname = resolvedHost;
    resolved.port = String(target.port);
  }
  return {
    requestedUrl: requestedUrl ?? `${protocol}://localhost:${target.port}${path}`,
    resolvedUrl: resolved.toString(),
    resolutionKind: isLocalLoopbackHost(normalizedEnvironmentHost)
      ? "direct"
      : "direct-private-network",
    environmentId,
  };
};

export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    return {
      requestedUrl: target.url,
      resolvedUrl: target.url,
      resolutionKind: "direct",
      environmentId,
    };
  }
  if (target.kind === "workspace-file" || target.kind === "local-file") {
    throw new Error("ファイルのプレビューには環境の署名URLが必要です。");
  }
  return resolveEnvironmentPortTarget(environmentId, target, readEnvironmentUrl(environmentId));
}

/** File paths remain on the server; clients only resolve the returned signed URL. */
export async function resolveBrowserFileNavigationTarget<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly target: Extract<
    BrowserNavigationTarget,
    { readonly kind: "workspace-file" | "local-file" }
  >;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, E>>;
}): Promise<PreviewUrlResolution> {
  const environmentUrl = readEnvironmentUrl(input.threadRef.environmentId);
  const result = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: input.target.kind === "workspace-file" ? "workspace-file" : "media-file",
        threadId: input.threadRef.threadId,
        path: input.target.path,
      },
    },
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const resolvedUrl = resolveAssetUrl(environmentUrl.href, result.value.relativeUrl);
  if (resolvedUrl === null || !/^https?:\/\//i.test(resolvedUrl)) {
    throw new Error("環境から無効なプレビューURLが返されました。");
  }
  return {
    requestedUrl: input.target.path,
    resolvedUrl,
    resolutionKind: "direct",
    environmentId: input.threadRef.environmentId,
  };
}

export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    const parsed = new URL(normalizedUrl);
    if (!isLoopbackHost(parsed.hostname)) return normalizedUrl;
    return resolveEnvironmentPortTarget(
      environmentId,
      {
        kind: "environment-port",
        port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
        protocol: parsed.protocol === "https:" ? "https" : "http",
        path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
      },
      readEnvironmentUrl(environmentId),
      rawUrl,
      parsed,
    ).resolvedUrl;
  } catch {
    return rawUrl;
  }
}
