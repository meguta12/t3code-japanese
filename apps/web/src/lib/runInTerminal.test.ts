import {
  EnvironmentId,
  ThreadId,
  type TerminalOpenInput,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  confirmTerminalReady,
  createChatTerminalId,
  runInTerminal,
  waitForTerminalOutput,
} from "./runInTerminal";

const ref = scopeThreadRef(EnvironmentId.make("remote-environment"), ThreadId.make("thread"));
const snapshot = (input: TerminalOpenInput, history = ""): TerminalSessionSnapshot => ({
  ...input,
  worktreePath: input.worktreePath ?? null,
  status: "running",
  pid: 123,
  history,
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-10-11T00:00:00Z",
});
const baseInput = {
  threadRef: ref,
  command: 'echo "Done and original"',
  target: "drawer" as const,
  submit: true,
  cwd: "/tmp/project",
  worktreePath: null,
  env: { PROJECT: "original" },
};

function harness() {
  let ready: (() => void) | undefined;
  const write = vi.fn<Parameters<typeof runInTerminal>[1]["write"]>(async () => {});
  const notifyFailure = vi.fn();
  const showTerminal = vi.fn((targetRef, id, target) => {
    if (target === "panel") useRightPanelStore.getState().openTerminal(targetRef, id);
    else useTerminalUiStateStore.getState().ensureTerminal(targetRef, id, { open: true });
  });
  const dependencies: Parameters<typeof runInTerminal>[1] = {
    allocateTerminalId: (targetRef) =>
      nextTerminalId([
        ...selectThreadTerminalUiState(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
          targetRef,
        ).terminalIds,
        ...selectThreadRightPanelState(
          useRightPanelStore.getState().byThreadKey,
          targetRef,
        ).surfaces.flatMap((s) => (s.kind === "terminal" ? s.terminalIds : [])),
      ]),
    isThreadActive: () => true,
    showTerminal,
    open: vi.fn(async (_ref, input) => snapshot(input)),
    waitForOutput: vi.fn(
      async (_ref, _input, _snapshot) =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    ),
    write,
    notifyFailure,
  };
  return { dependencies, write, notifyFailure, showTerminal, ready: () => ready?.() };
}

afterEach(() => {
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat commands in visible terminals", () => {
  it("uses independent ids across clients with the same terminal metadata", () => {
    const firstClientId = createChatTerminalId();
    const secondClientId = createChatTerminalId();
    expect(firstClientId).not.toBe(secondClientId);
    expect(firstClientId).toMatch(/^chat-/);
  });
  it("allocates sessions on a remote HTTP origin without crypto.randomUUID", () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: original.getRandomValues.bind(original) });
    expect(createChatTerminalId()).toMatch(/^chat-[\da-f-]{36}$/);
  });
  it("allocates a fresh drawer session even when the known terminal belongs to a hidden panel", async () => {
    useRightPanelStore.getState().openTerminal(ref, "term-1");
    useRightPanelStore.getState().close(ref);
    const h = harness();
    const running = runInTerminal(baseInput, h.dependencies);
    await Promise.resolve();
    const drawer = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      ref,
    );
    expect(drawer.terminalOpen).toBe(true);
    expect(drawer.activeTerminalId).toBe("term-2");
    expect(h.write).not.toHaveBeenCalled();
    h.ready();
    await running;
    expect(h.write).toHaveBeenCalledExactlyOnceWith(ref, {
      threadId: ref.threadId,
      terminalId: "term-2",
      data: `${baseInput.command}\r`,
    });
    expect(h.notifyFailure).not.toHaveBeenCalled();
  });

  it("opens the selected right panel and pastes the original command without Enter", async () => {
    const h = harness();
    const running = runInTerminal({ ...baseInput, target: "panel", submit: false }, h.dependencies);
    await Promise.resolve();
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(panel.isOpen).toBe(true);
    expect(panel.activeSurfaceId).toBe("terminal:term-1");
    h.ready();
    await running;
    expect(h.write).toHaveBeenCalledExactlyOnceWith(ref, {
      threadId: ref.threadId,
      terminalId: "term-1",
      data: baseInput.command,
    });
  });

  it("reserves different ids for two clicks before another React render", async () => {
    const h = harness();
    h.dependencies.waitForOutput = async () => {};
    await Promise.all([
      runInTerminal(baseInput, h.dependencies),
      runInTerminal(baseInput, h.dependencies),
    ]);
    expect(h.write.mock.calls.map((call) => call[1].terminalId)).toEqual(["term-1", "term-2"]);
  });

  it.each([
    { threadRef: null },
    { cwd: null },
    { cwd: "   " },
    { command: "" },
    { command: "echo one\necho two" },
    { command: "a".repeat(65_536) },
  ])(
    "notifies and never opens or writes for missing/invalid launch information: %j",
    async (override) => {
      const h = harness();
      await runInTerminal({ ...baseInput, ...override }, h.dependencies);
      expect(h.dependencies.open).not.toHaveBeenCalled();
      expect(h.write).not.toHaveBeenCalled();
      expect(h.notifyFailure).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["open", "waitForOutput", "write"] as const)(
    "notifies every %s failure and never retries the command",
    async (operation) => {
      const h = harness();
      h.dependencies.waitForOutput = async () => {};
      h.dependencies[operation] = vi.fn(async () => {
        throw new Error("入力は中断されました");
      });
      await runInTerminal(baseInput, h.dependencies);
      expect(h.notifyFailure).toHaveBeenCalledExactlyOnceWith(
        "ターミナルで実行できませんでした",
        "入力は中断されました",
      );
      expect(h.dependencies[operation]).toHaveBeenCalledTimes(1);
    },
  );

  it("restores the destination closed during startup before writing", async () => {
    const h = harness();
    const running = runInTerminal(baseInput, h.dependencies);
    await Promise.resolve();
    useTerminalUiStateStore.getState().setTerminalOpen(ref, false);
    h.ready();
    await running;
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        ref,
      ).terminalOpen,
    ).toBe(true);
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it("cancels with a notification if the user switches threads while the shell starts", async () => {
    const h = harness();
    const running = runInTerminal(baseInput, h.dependencies);
    await Promise.resolve();
    h.dependencies.isThreadActive = () => false;
    h.ready();
    await running;
    expect(h.write).not.toHaveBeenCalled();
    expect(h.notifyFailure).toHaveBeenCalledTimes(1);
  });
});

describe("shell output readiness", () => {
  const input: TerminalOpenInput = {
    threadId: ref.threadId,
    terminalId: "term-1",
    cwd: "/tmp/project",
  };
  it("waits after started and releases only on running output, then unsubscribes", async () => {
    let listener:
      | Parameters<Parameters<typeof waitForTerminalOutput>[0]["subscribe"]>[0]
      | undefined;
    const unsubscribe = vi.fn();
    const pending = waitForTerminalOutput({
      snapshot: snapshot(input),
      subscribe: (cb) => {
        listener = cb;
        return unsubscribe;
      },
    });
    const finished = vi.fn();
    pending.then(finished);
    listener?.({ status: "running", hasOutput: false });
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    listener?.({ status: "running", hasOutput: true });
    await pending;
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith();
  });

  it("accepts a snapshot whose output arrived before the subscription", async () => {
    const subscribe = vi.fn();
    await waitForTerminalOutput({ snapshot: snapshot(input, "prompt> "), subscribe });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it.each(["exited", "error", "closed"] as const)(
    "rejects %s even if old output exists and cleans up a synchronous subscription",
    async (status) => {
      const unsubscribe = vi.fn();
      await expect(
        waitForTerminalOutput({
          snapshot: snapshot(input),
          subscribe: (cb) => {
            cb({ status, hasOutput: true });
            return unsubscribe;
          },
        }),
      ).rejects.toThrow();
      expect(unsubscribe).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it("times out without polling and releases the output subscription", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const pending = waitForTerminalOutput({
      snapshot: snapshot(input),
      subscribe: () => unsubscribe,
    });
    const rejected = expect(pending).rejects.toThrow("シェルの起動を確認できませんでした");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith();
  });

  it("requires the probe's result, not a banner, input echo, or startup read consuming it", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    let callback:
      | Parameters<Parameters<typeof waitForTerminalOutput>[0]["subscribe"]>[0]
      | undefined;
    let nonce = "";
    const writeProbe = vi.fn(async (data: string) => {
      nonce = data.slice(5, -1);
    });
    const pending = confirmTerminalReady({
      snapshot: snapshot(input, "early banner\r\n"),
      subscribe: (cb) => {
        callback = cb;
        return unsubscribe;
      },
      writeProbe,
      isThreadActive: () => true,
    });
    const rejected = expect(pending).rejects.toThrow("シェルの起動を確認できませんでした");
    await Promise.resolve();
    expect(writeProbe).toHaveBeenCalledTimes(1);
    callback?.({
      status: "running",
      hasOutput: true,
      output: `echo ${nonce}\r\nSTARTUP_CONSUMED:echo ${nonce}\r\n`,
    });
    expect(unsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("accepts the unique standalone probe line and unsubscribes before the user command", async () => {
    const unsubscribe = vi.fn();
    let callback:
      | Parameters<Parameters<typeof waitForTerminalOutput>[0]["subscribe"]>[0]
      | undefined;
    let nonce = "";
    const pending = confirmTerminalReady({
      snapshot: snapshot(input, "prompt> "),
      subscribe: (cb) => {
        callback = cb;
        return unsubscribe;
      },
      writeProbe: async (data) => {
        nonce = data.slice(5, -1);
      },
      isThreadActive: () => true,
    });
    await Promise.resolve();
    callback?.({
      status: "running",
      hasOutput: true,
      output: `prompt> echo ${nonce}\r\r\n${nonce}\r\n`,
    });
    await pending;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
