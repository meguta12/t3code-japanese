// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createGuardedHttpServer, guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";

const servers: NodeHttp.Server[] = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

function fetchStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => reject(new Error("request timed out")));
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("guardHttpResponseWriteErrors", () => {
  it("contains an upgrade socket write failure instead of crashing the process", async () => {
    const writeErrors: unknown[] = [];
    const failureObserved = Promise.withResolvers<void>();
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      writeErrors.push(error);
      failureObserved.resolve();
    });

    server.on("upgrade", (_request, socket) => {
      // Simulate the client vanishing while the auth rejection response is
      // written to the upgrade socket: the write failure surfaces as an
      // "error" event on a socket Node's http server no longer listens to.
      socket.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    });

    const port = await listen(server);

    const client = NodeNet.connect(port, "127.0.0.1", () => {
      client.write(
        [
          "GET /rpc HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    client.on("error", () => {});

    await failureObserved.promise;
    client.destroy();

    expect(writeErrors).toHaveLength(1);
    expect(writeErrors[0]).toBeInstanceOf(Error);
    expect((writeErrors[0] as NodeJS.ErrnoException).code).toBe("EPIPE");

    // The process survived the failed write and the server keeps serving.
    server.on("request", (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await expect(fetchStatus(port, "/")).resolves.toBe(200);
  });

  it("arms every response with an error listener without disturbing normal traffic", async () => {
    const writeErrors: unknown[] = [];
    let responseErrorListeners = -1;
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      writeErrors.push(error);
    });

    server.on("request", (_request, response) => {
      responseErrorListeners = response.listenerCount("error");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });

    const port = await listen(server);

    await expect(fetchStatus(port, "/")).resolves.toBe(200);
    expect(responseErrorListeners).toBeGreaterThan(0);
    expect(writeErrors).toEqual([]);
  });
});

describe("createGuardedHttpServer", () => {
  it("keeps body deadlines on ordinary requests and exempts only PUT attachment uploads", () => {
    vi.useFakeTimers();
    try {
      const server = createGuardedHttpServer(NodeHttp.createServer());
      expect(server.headersTimeout).toBeGreaterThan(0);
      for (const [method, url, timedOut] of [
        ["POST", "/api/rpc", true],
        ["GET", "/api/attachments/upload/token", true],
        ["PUT", "/api/attachments/upload-other/token", true],
        ["PUT", "/api/attachments/upload/token", false],
      ] as const) {
        const request = new NodeHttp.IncomingMessage(new NodeNet.Socket());
        request.method = method;
        request.url = url;
        const response = new NodeHttp.ServerResponse(request);
        const finish = vi.spyOn(response, "end").mockReturnValue(response);
        server.emit("request", request, response);
        vi.advanceTimersByTime(300_000);
        expect(finish).toHaveBeenCalledTimes(timedOut ? 1 : 0);
        request.emit("close");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the deadline once the body arrives", () => {
    vi.useFakeTimers();
    try {
      const server = createGuardedHttpServer(NodeHttp.createServer());
      const request = new NodeHttp.IncomingMessage(new NodeNet.Socket());
      request.method = "POST";
      request.url = "/api/rpc";
      const response = new NodeHttp.ServerResponse(request);
      const finish = vi.spyOn(response, "end").mockReturnValue(response);
      server.emit("request", request, response);
      request.emit("end");
      vi.advanceTimersByTime(300_000);
      expect(finish).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a response that already sent headers without crashing at its body deadline", () => {
    vi.useFakeTimers();
    try {
      const server = createGuardedHttpServer(NodeHttp.createServer());
      const request = new NodeHttp.IncomingMessage(new NodeNet.Socket());
      request.method = "POST";
      request.url = "/api/rpc";
      const response = new NodeHttp.ServerResponse(request);
      const destroy = vi.spyOn(response, "destroy");
      server.emit("request", request, response);
      response.writeHead(200);
      expect(() => vi.advanceTimersByTime(300_000)).not.toThrow();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an incomplete body when a handler ends its response early", () => {
    const server = createGuardedHttpServer(NodeHttp.createServer());
    for (const url of ["/api/rpc", "/api/attachments/upload/invalid-token"]) {
      const request = new NodeHttp.IncomingMessage(new NodeNet.Socket());
      request.method = "PUT";
      request.url = url;
      const response = new NodeHttp.ServerResponse(request);
      const destroy = vi.spyOn(request, "destroy");
      server.emit("request", request, response);
      response.emit("close");
      expect(destroy).toHaveBeenCalledTimes(1);
    }
  });
});
