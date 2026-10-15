// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";

/**
 * Node surfaces late socket write failures (EPIPE, ECONNRESET,
 * ERR_STREAM_DESTROYED) as "error" events. An "error" event without a
 * listener escalates into an uncaught exception and terminates the whole
 * server process, taking every other client and all in-flight provider
 * work with it.
 *
 * Two emitters need coverage:
 *
 * - Upgrade sockets. Once a connection upgrades (the websocket RPC path,
 *   including its auth rejection responses), Node's http server detaches
 *   its own socket error handling, so the raw socket has no listener at
 *   all until the websocket server adopts it.
 * - Server responses. Response streams have no default error listener
 *   either.
 *
 * A disconnected client only affects its own request: the request fiber is
 * already interrupted through the response "close" event, so the write
 * failure needs no handling beyond being observed.
 */
export function guardHttpResponseWriteErrors<T extends NodeHttp.Server>(
  server: T,
  onError?: (error: unknown) => void,
): T {
  server.on("request", (_request, response) => {
    response.on("error", (error) => {
      onError?.(error);
    });
  });
  server.on("upgrade", (_request, socket) => {
    socket.on("error", (error) => {
      onError?.(error);
    });
  });
  return server;
}

/**
 * `guardHttpResponseWriteErrors` plus the request-timeout policy for the
 * app's HTTP server.
 *
 * Node's body deadline is server-wide. Replace it with a per-request deadline
 * so only PUT attachment uploads can exceed it. Their handler enforces idle
 * and minimum-rate limits; all other bodies retain the original deadline.
 * Header deadlines remain managed by Node.
 */
export function createGuardedHttpServer<T extends NodeHttp.Server>(
  server: T,
  onError?: (error: unknown) => void,
): T {
  const bodyTimeout = server.requestTimeout || 300_000;
  server.requestTimeout = 0;
  server.on("request", (request, response) => {
    response.once("close", () => {
      if (!request.complete) request.destroy();
    });
    if (
      request.method === "PUT" &&
      /^\/api\/attachments\/upload\/[^/?]+(?:\?.*)?$/.test(request.url ?? "")
    )
      return;
    if (request.complete) return;
    const deadline = setTimeout(() => {
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(408, { connection: "close" });
        response.end();
      }
      request.destroy();
    }, bodyTimeout);
    deadline.unref();
    const clearDeadline = () => clearTimeout(deadline);
    request.once("end", clearDeadline);
    request.once("close", clearDeadline);
  });
  return guardHttpResponseWriteErrors(server, onError);
}
