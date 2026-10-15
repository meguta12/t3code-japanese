import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import {
  OpenCodeSettings,
  ProviderInstanceId,
  ApprovalRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import {
  makeConnection,
  openCode2Request,
  verifyOpenCode2,
  type OpenCode2Runtime,
} from "../OpenCode2Runtime.ts";
import { makeOpenCode2Adapter, openCode2Rules } from "./OpenCode2Adapter.ts";
import { checkOpenCode2ProviderStatus } from "./OpenCodeProvider.ts";

const settings = Schema.decodeSync(OpenCodeSettings)({ enabled: true });
const selection = { instanceId: ProviderInstanceId.make("opencode"), model: "opencode/big-pickle" };

async function fixture() {
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-opencode2-test-"));
  const streams = new Set<NodeHttp.ServerResponse>();
  const requests: Array<{
    path: string;
    method: string;
    body: Record<string, unknown>;
    authorization?: string;
  }> = [];
  let native = 0;
  let eventId = 0;
  let failPrompt = false;
  let history = ["msg_old", "msg_new"];
  const server = NodeHttp.createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    requests.push({
      path,
      method: req.method!,
      body,
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    });
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from("opencode:test-password").toString("base64")}`
    ) {
      res.writeHead(401).end();
      return;
    }
    if (path === "/api/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": ready\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    const json = (data: unknown) => res.end(JSON.stringify(data));
    if (path === "/api/info")
      return json({ version: "2.0.25", pid: 123, urls: [], paths: { tmp: cwd } });
    if (path === "/api/model")
      return json({
        location: { directory: cwd },
        data: [
          {
            id: "big-pickle",
            modelID: "big-pickle",
            providerID: "opencode",
            name: "Big Pickle",
            enabled: true,
            variants: [],
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
            limit: { context: 128000, output: 8192 },
            time: { released: 0 },
            status: "active",
          },
        ],
      });
    if (/^\/api\/session\/ses_\d+$/.test(path) && req.method === "GET")
      return json({
        data: {
          id: path.split("/").at(-1),
          location: { directory: cwd },
          time: { created: 0, updated: 0 },
        },
      });
    if (path.endsWith("/message"))
      return json({
        data: history.map((id) => ({ id, type: "user", text: id, time: { created: 0 } })),
        cursor: {},
      });
    if (path.endsWith("/revert/commit")) {
      history = history.slice(0, -1);
      res.writeHead(204).end();
      return;
    }
    if (path.endsWith("/revert/stage")) return json({ data: {} });
    if (path.endsWith("/compact")) return json({ data: { id: body.id } });
    if (path === "/api/session" && req.method === "POST")
      return json({
        data: {
          id: `ses_${++native}`,
          location: { directory: cwd },
          time: { created: 0, updated: 0 },
        },
      });
    if (path.endsWith("/prompt")) {
      if (failPrompt) {
        res.writeHead(503);
        return json({ type: "ServiceUnavailableError", message: "offline" });
      }
      return json({ data: { id: body.id, type: "user", payload: { text: body.text } } });
    }
    if (path.endsWith("/interrupt")) return json({ interrupted: true });
    if (
      req.method === "PATCH" ||
      req.method === "PUT" ||
      req.method === "POST" ||
      req.method === "DELETE"
    ) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404);
    json({ message: path });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const connection = makeConnection(`http://127.0.0.1:${address.port}`, "test-password", false);
  const runtime: OpenCode2Runtime = {
    detect: Effect.succeed(true),
    connection: Effect.succeed(connection),
    models: (directory) =>
      openCode2Request("model.list", (signal) =>
        connection.client.model.list({ location: { directory } }, { signal }),
      ).pipe(Effect.map((result) => result.data)),
    workspace: () => Effect.die("not used in this test"),
  };
  return {
    cwd,
    requests,
    runtime,
    connection,
    failPrompt: () => {
      failPrompt = true;
    },
    emit(type: string, data: Record<string, unknown>) {
      const frame = `data: ${JSON.stringify({ id: `evt_${++eventId}`, type, created: Date.now(), data })}\n\n`;
      for (const stream of streams) stream.write(frame);
    },
    close: async () => {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await NodeFSP.rm(cwd, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Adapter = Effect.Success<ReturnType<typeof makeOpenCode2Adapter>>;
const take = (
  queue: Queue.Queue<ProviderRuntimeEvent>,
  predicate: (event: ProviderRuntimeEvent) => boolean,
): Effect.Effect<ProviderRuntimeEvent> =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      if (predicate(event)) return event;
    }
  });
function testAdapter(
  use: (
    adapter: Adapter,
    f: Fixture,
    receipts: Queue.Queue<ProviderRuntimeEvent>,
  ) => Effect.Effect<void, unknown>,
) {
  return Effect.gen(function* () {
    const f = yield* Effect.acquireRelease(Effect.promise(fixture), (value) =>
      Effect.promise(value.close),
    );
    yield* Effect.gen(function* () {
      const adapter = yield* makeOpenCode2Adapter(settings, f.runtime);
      const receipts = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Queue.offer(receipts, event)),
        Effect.forkScoped,
      );
      yield* use(adapter, f, receipts);
    }).pipe(
      Effect.provide(ServerConfig.layerTest(f.cwd, { prefix: "t3-opencode2-config-" })),
      Effect.provide(NodeServices.layer),
    );
  }).pipe(Effect.scoped);
}
const start = (
  adapter: Adapter,
  f: Fixture,
  suffix = "one",
  runtimeMode: "full-access" | "approval-required" = "full-access",
) =>
  adapter.startSession({
    threadId: ThreadId.make(`thread-${suffix}`),
    cwd: f.cwd,
    runtimeMode,
    modelSelection: selection,
  });

it.live(
  "connects to the authenticated v2 API and returns free models without v1 health probes",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (value) =>
        Effect.promise(value.close),
      );
      expect(yield* verifyOpenCode2(f.connection)).toBe("2.0.25");
      const status = yield* checkOpenCode2ProviderStatus(settings, f.cwd, f.runtime);
      expect(status.status).toBe("ready");
      expect(status.models.map((model) => model.slug)).toEqual(["opencode/big-pickle"]);
      expect(f.requests.every((request) => request.path.startsWith("/api/"))).toBe(true);
    }),
);

it.live("streams a free-model answer and finishes only on the owning session's terminal", () =>
  testAdapter((adapter, f, receipts) =>
    Effect.gen(function* () {
      const session = yield* start(adapter, f);
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Reply OK",
        modelSelection: selection,
      });
      expect(f.requests.find((request) => request.path === "/api/session")?.body.model).toEqual({
        providerID: "opencode",
        id: "big-pickle",
      });
      f.emit("session.created", { sessionID: "ses_child", parentID: "ses_1" });
      f.emit("session.execution.succeeded", { sessionID: "ses_child" });
      f.emit("session.text.delta", {
        sessionID: "ses_1",
        assistantMessageID: "msg_answer",
        ordinal: 0,
        delta: "OK",
      });
      const delta = yield* take(receipts, (event) => event.type === "content.delta");
      expect(delta.turnId).toBe(turn.turnId);
      expect(delta.payload).toEqual({ streamKind: "assistant_text", delta: "OK" });
      expect((yield* adapter.listSessions())[0]?.status).toBe("running");
      f.emit("session.execution.succeeded", { sessionID: "ses_1" });
      const done = yield* take(receipts, (event) => event.type === "turn.completed");
      expect(done.payload).toEqual({ state: "completed" });
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
    }),
  ),
);

it.live("forwards approval requests and rejection without granting other sessions access", () =>
  testAdapter((adapter, f, receipts) =>
    Effect.gen(function* () {
      const session = yield* start(adapter, f, "one", "approval-required");
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Inspect",
        modelSelection: selection,
      });
      f.emit("permission.asked", {
        id: "perm_1",
        sessionID: "ses_1",
        action: "shell",
        resources: ["git status"],
      });
      const approval = yield* take(receipts, (event) => event.type === "request.opened");
      expect(approval.requestId).toBe("perm_1");
      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make("perm_1"),
        "decline",
      );
      const reply = f.requests.find((request) => request.path.endsWith("/permission/perm_1/reply"));
      expect(reply?.body).toEqual({
        decision: "reject",
        message: "The user denied this action. Continue without performing it.",
      });
      yield* adapter.interruptTurn(session.threadId);
      expect(f.requests.some((request) => request.path === "/api/session/ses_1/interrupt")).toBe(
        true,
      );
      expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
    }),
  ),
);

it.live("keeps full-access approvals request-local and session grants thread-local", () =>
  testAdapter((adapter, f, receipts) =>
    Effect.gen(function* () {
      const session = yield* start(adapter, f);
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Inspect",
        modelSelection: selection,
      });
      f.emit("permission.asked", {
        id: "perm_2",
        sessionID: "ses_1",
        action: "shell",
        resources: ["pwd"],
      });
      f.emit("session.text.delta", {
        sessionID: "ses_1",
        assistantMessageID: "msg_marker",
        ordinal: 0,
        delta: "marker",
      });
      yield* take(receipts, (event) => event.type === "content.delta");
      expect(
        f.requests.find((request) => request.path.endsWith("/permission/perm_2/reply"))?.body,
      ).toEqual({ decision: "once" });
      const rules = openCode2Rules("full-access", "thread-one", false);
      expect(rules.slice(-2)).toEqual([
        { action: "t3-code-*", resource: "*", effect: "deny" },
        { action: "t3-code-thread-one_*", resource: "*", effect: "allow" },
      ]);
    }),
  ),
);

it.live("does not leave a failed prompt running or retry it against another model", () =>
  testAdapter((adapter, f, receipts) =>
    Effect.gen(function* () {
      const session = yield* start(adapter, f);
      f.failPrompt();
      const result = yield* adapter
        .sendTurn({ threadId: session.threadId, input: "test", modelSelection: selection })
        .pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      const done = yield* take(receipts, (event) => event.type === "turn.completed");
      expect(done.payload).toMatchObject({ state: "failed" });
      expect(f.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(1);
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
    }),
  ),
);

it.live("keeps a full terminal text when the delta was absent", () =>
  testAdapter((adapter, f, receipts) =>
    Effect.gen(function* () {
      const session = yield* start(adapter, f);
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "test",
        modelSelection: selection,
      });
      f.emit("session.text.ended", {
        sessionID: "ses_1",
        assistantMessageID: "msg_end",
        ordinal: 0,
        text: "Complete answer",
      });
      const delta = yield* take(receipts, (event) => event.type === "content.delta");
      expect(delta.payload).toEqual({ streamKind: "assistant_text", delta: "Complete answer" });
    }),
  ),
);

it.live("returns native option values when a question is answered by its display label", () =>
  testAdapter((adapter, f, receipts) =>
    Effect.gen(function* () {
      const session = yield* start(adapter, f);
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "test",
        modelSelection: selection,
      });
      f.emit("form.created", {
        form: {
          id: "form_1",
          sessionID: "ses_1",
          title: "Choose",
          fields: [
            {
              type: "string",
              key: "color",
              title: "Color",
              options: [{ value: "red-code", label: "Red", description: "A color" }],
            },
          ],
        },
      });
      yield* take(receipts, (event) => event.type === "user-input.requested");
      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make("form_1"), {
        color: "Red",
      });
      expect(
        f.requests.find((request) => request.path.endsWith("/form/form_1/reply"))?.body,
      ).toEqual({ answer: { color: "red-code" } });
    }),
  ),
);

it.live(
  "resumes legacy OpenCode cursors and rewinds conversation without editing workspace files",
  () =>
    testAdapter((adapter, f) =>
      Effect.gen(function* () {
        const session = yield* adapter.startSession({
          threadId: ThreadId.make("resumed"),
          cwd: f.cwd,
          runtimeMode: "full-access",
          modelSelection: selection,
          resumeCursor: { schemaVersion: 1, sessionId: "ses_1" },
        });
        expect(
          f.requests.filter(
            (request) => request.path === "/api/session" && request.method === "POST",
          ),
        ).toHaveLength(0);
        const before = yield* adapter.readThread(session.threadId);
        expect(before.turns.map((turn) => turn.id)).toEqual(["msg_old", "msg_new"]);
        const after = yield* adapter.rollbackThread(session.threadId, 1);
        expect(after.turns.map((turn) => turn.id)).toEqual(["msg_old"]);
        expect(f.requests.find((request) => request.path.endsWith("/revert/stage"))?.body).toEqual({
          messageID: "msg_new",
          files: false,
        });
      }),
    ),
);

it.live("starts native compaction and releases its running state at completion", () =>
  testAdapter((adapter, f, receipts) =>
    Effect.gen(function* () {
      const session = yield* start(adapter, f);
      const compaction = adapter.compaction;
      if (!compaction || compaction.type !== "native") throw new Error("native compaction missing");
      yield* compaction.start(session.threadId);
      expect((yield* adapter.listSessions())[0]?.status).toBe("running");
      f.emit("session.execution.succeeded", { sessionID: "ses_1" });
      yield* take(receipts, (event) => event.type === "turn.completed");
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
    }),
  ),
);

it.live("applies a stricter permission mode to an already connected session", () =>
  testAdapter((adapter, f, receipts) =>
    Effect.gen(function* () {
      const session = yield* start(adapter, f);
      const updated = yield* start(adapter, f, "one", "approval-required");
      expect(updated.runtimeMode).toBe("approval-required");
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "test",
        modelSelection: selection,
      });
      f.emit("permission.asked", {
        id: "mode_approval",
        sessionID: "ses_1",
        action: "shell",
        resources: ["pwd"],
      });
      yield* take(receipts, (event) => event.type === "request.opened");
      expect(f.requests.some((request) => request.path.includes("mode_approval/reply"))).toBe(
        false,
      );
    }),
  ),
);
