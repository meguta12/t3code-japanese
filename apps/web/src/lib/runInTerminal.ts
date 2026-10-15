import type {
  ScopedThreadRef,
  TerminalOpenInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { randomUUID } from "./utils";

export interface ShellCommandRunOptions {
  target: "drawer" | "panel";
  submit: boolean;
}

/** A sequential id can collide when two clients have the same metadata. */
export function createChatTerminalId(): string {
  return `chat-${randomUUID()}`;
}

interface TerminalRunState {
  status: TerminalSessionSnapshot["status"] | "closed";
  hasOutput: boolean;
  error?: string | null;
  output?: string;
}

/** A started PTY can still be initializing its shell. Wait for output, with a
 * snapshot read by the subscriber so output emitted before attachment is kept. */
export function waitForTerminalOutput({
  snapshot,
  subscribe,
  timeoutMs = 15_000,
  expectedLine,
  onSubscribed,
}: {
  snapshot: TerminalSessionSnapshot;
  subscribe: (listener: (state: TerminalRunState) => void) => () => void;
  timeoutMs?: number;
  expectedLine?: string;
  onSubscribed?: () => Promise<void>;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () =>
        finish(new Error("シェルの起動を確認できませんでした。端末を確認して再度お試しください。")),
      timeoutMs,
    );
    const inspect = (state: TerminalRunState) => {
      if (state.error || state.status === "error") {
        finish(new Error(state.error || "ターミナルの起動に失敗しました。"));
      } else if (state.status === "exited" || state.status === "closed") {
        finish(new Error("入力する前にターミナルが終了しました。"));
      } else if (
        state.status === "running" &&
        (expectedLine
          ? state.output?.split("\n").some((line) => line.replace(/\r/g, "") === expectedLine)
          : state.hasOutput)
      ) {
        finish();
      }
    };
    inspect({
      status: snapshot.status,
      hasOutput: snapshot.history.length > 0,
      output: snapshot.history,
    });
    if (settled) return;
    try {
      unsubscribe = subscribe(inspect);
      // Some registries deliver their current snapshot synchronously.
      if (settled) unsubscribe();
      else if (onSubscribed)
        void onSubscribed().catch((error) =>
          finish(error instanceof Error ? error : new Error("ターミナルへの入力に失敗しました。")),
        );
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error("ターミナルの状態を取得できませんでした。"),
      );
    }
  });
}

/** Startup scripts can print a banner, then consume input with `read`. An
 * echoed command is not acknowledgement: only the nonce on its own line is.
 * Echo works in POSIX shells, fish, PowerShell, and cmd without a shell guess. */
export async function confirmTerminalReady({
  snapshot,
  subscribe,
  writeProbe,
  isThreadActive,
}: {
  snapshot: TerminalSessionSnapshot;
  subscribe: Parameters<typeof waitForTerminalOutput>[0]["subscribe"];
  writeProbe: (data: string) => Promise<void>;
  isThreadActive: () => boolean;
}): Promise<void> {
  await waitForTerminalOutput({ snapshot, subscribe });
  if (!isThreadActive())
    throw new Error("実行先のスレッドが切り替わったため、入力を中止しました。");
  const nonce = `T3_READY_${randomUUID().replaceAll("-", "")}`;
  await waitForTerminalOutput({
    snapshot,
    subscribe,
    expectedLine: nonce,
    onSubscribed: () => writeProbe(`echo ${nonce}\r`),
  });
}

interface RunInTerminalInput extends ShellCommandRunOptions {
  threadRef: ScopedThreadRef | null;
  command: string;
  cwd: string | null;
  worktreePath: string | null;
  env: Record<string, string>;
}

interface RunInTerminalDependencies {
  allocateTerminalId: (ref: ScopedThreadRef) => string;
  isThreadActive: (ref: ScopedThreadRef) => boolean;
  showTerminal: (
    ref: ScopedThreadRef,
    terminalId: string,
    target: ShellCommandRunOptions["target"],
  ) => void;
  open: (ref: ScopedThreadRef, input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
  waitForOutput: (
    ref: ScopedThreadRef,
    input: TerminalOpenInput,
    snapshot: TerminalSessionSnapshot,
  ) => Promise<void>;
  write: (ref: ScopedThreadRef, input: TerminalWriteInput) => Promise<void>;
  notifyFailure: (title: string, description: string) => void;
}

/** Each code-block click gets a new, explicitly visible session. Commands and
 * server error details stay verbatim; only fixed UI messages are Japanese. */
export async function runInTerminal(
  input: RunInTerminalInput,
  dependencies: RunInTerminalDependencies,
): Promise<void> {
  try {
    const { threadRef, command, cwd } = input;
    if (!threadRef)
      throw new Error("実行先のスレッドが見つかりません。スレッドを開き直してください。");
    if (!cwd?.trim()) throw new Error("実行先のプロジェクトフォルダーがありません。");
    if (
      !command.trim() ||
      /[\p{Cc}\p{Cf}]/u.test(command) ||
      command.length + Number(input.submit) > 65_536
    ) {
      throw new Error("このコマンドはターミナルへ送れません。内容と長さを確認してください。");
    }
    const ensureActive = () => {
      if (!dependencies.isThreadActive(threadRef)) {
        throw new Error("実行先のスレッドが切り替わったため、入力を中止しました。");
      }
    };
    ensureActive();
    const terminalId = dependencies.allocateTerminalId(threadRef);
    const openInput: TerminalOpenInput = {
      threadId: threadRef.threadId,
      terminalId,
      cwd,
      worktreePath: input.worktreePath,
      env: input.env,
      cols: 120,
      rows: 30,
    };
    dependencies.showTerminal(threadRef, terminalId, input.target);
    const snapshot = await dependencies.open(threadRef, openInput);
    await dependencies.waitForOutput(threadRef, openInput, snapshot);
    ensureActive();
    // The user may have closed the drawer or selected another panel while the
    // shell started. Restore the selected destination before sending input.
    dependencies.showTerminal(threadRef, terminalId, input.target);
    await dependencies.write(threadRef, {
      threadId: threadRef.threadId,
      terminalId,
      data: input.submit ? `${command}\r` : command,
    });
  } catch (error) {
    dependencies.notifyFailure(
      input.submit ? "ターミナルで実行できませんでした" : "ターミナルへ貼り付けできませんでした",
      error instanceof Error ? error.message : "ターミナルへの入力に失敗しました。",
    );
  }
}
