import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  commandCodeCreditsToLimits,
  readCommandCodeUsageLimits,
} from "./commandCodeUsageLimits.ts";

const checkedAt = "2026-10-07T00:00:00.000Z";

// Shape of GET /alpha/billing/credits for a Go plan (captured 2026-10-07, numbers rounded,
// identifiers dropped): the rolling caps sit in `windowLimits`, resets are epoch millis.
const creditsBody = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 5.5, purchasedCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 4, cap: 16, exceeded: false, resetAt: Date.parse("2026-10-07T03:00:00Z") },
    weekly: { used: 10, cap: 40, exceeded: false, resetAt: Date.parse("2026-10-13T00:00:00Z") },
  },
  sandboxAccess: false,
  sandboxMinutes: null,
};

describe("commandCodeCreditsToLimits", () => {
  it("maps the 5-hour and weekly caps to used percent and reset time", () => {
    expect(commandCodeCreditsToLimits(creditsBody, checkedAt)).toEqual({
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: "2026-10-07T03:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 25,
          windowDurationMins: 10_080,
          resetsAt: "2026-10-13T00:00:00.000Z",
        },
      ],
    });
  });

  it("trusts the server's exceeded flag and ignores windows without a cap", () => {
    const limits = commandCodeCreditsToLimits(
      {
        windowLimits: {
          fiveHour: { used: 15.99, cap: 16, exceeded: true },
          weekly: { used: 3, cap: 0 },
        },
      },
      checkedAt,
    );
    expect(limits.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 100],
    ]);
  });

  it("calls a plan with no rolling caps unsupported rather than empty", () => {
    for (const body of [{}, { windowLimits: null }, { windowLimits: { limited: false } }]) {
      const limits = commandCodeCreditsToLimits(body, checkedAt);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }
  });
});

const respond = (handler: (url: URL, authorization: string | undefined) => unknown) =>
  HttpClient.make((request) => {
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(handler(url, request.headers.authorization)),
      ),
    );
  });

it.layer(NodeServices.layer)("readCommandCodeUsageLimits", (it) => {
  it.effect("reads the CLI's stored login and sends it only as a bearer token", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(NodePath.join(home, ".commandcode"));
      yield* fs.writeFileString(
        NodePath.join(home, ".commandcode", "auth.json"),
        '{"apiKey":"stored-key","userName":"someone"}',
      );
      const routes: string[] = [];
      const limits = yield* readCommandCodeUsageLimits({ HOME: home }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respond((url, authorization) => {
            expect(url.origin).toBe("https://api.commandcode.ai");
            expect(authorization).toBe("Bearer stored-key");
            routes.push(`${url.pathname}${url.search}`);
            return url.pathname === "/alpha/whoami" ? { org: null } : creditsBody;
          }),
        ),
      );
      expect(routes).toEqual(["/alpha/whoami?limits=1", "/alpha/billing/credits"]);
      expect(limits.windows.map((window) => window.id)).toEqual(["five_hour", "weekly"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "prefers COMMAND_CODE_API_KEY and asks for the organization the account belongs to",
    () =>
      Effect.gen(function* () {
        const routes: string[] = [];
        const limits = yield* readCommandCodeUsageLimits({
          COMMAND_CODE_API_KEY: " env-key ",
          HOME: "/definitely/not/a/home",
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            respond((url, authorization) => {
              expect(authorization).toBe("Bearer env-key");
              routes.push(`${url.pathname}${url.search}`);
              return url.pathname === "/alpha/whoami" ? { org: { id: "org_1" } } : creditsBody;
            }),
          ),
        );
        expect(routes[1]).toBe("/alpha/billing/credits?orgId=org_1");
        expect(limits.windows).toHaveLength(2);
      }),
  );

  it.effect("reports a missing login as unsupported without any request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const limits = yield* readCommandCodeUsageLimits({ HOME: home }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not request without a login")),
        ),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );

  it.effect("collapses request and decode failures to a fixed message that omits the key", () =>
    Effect.gen(function* () {
      const failing = [
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("denied: secret-key", { status: 401 }),
            ),
          ),
        ),
        respond(() => ({ windowLimits: { fiveHour: { used: "not a number" } } })),
      ];
      for (const client of failing) {
        const limits = yield* readCommandCodeUsageLimits({
          COMMAND_CODE_API_KEY: "secret-key",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(limits.unavailable).toEqual({
          reason: "probeFailed",
          message: "Command Code could not read usage limits.",
        });
        expect(JSON.stringify(limits)).not.toContain("secret-key");
      }
    }),
  );
});
