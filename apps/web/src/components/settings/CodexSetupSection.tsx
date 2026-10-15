import { ja } from "../../lib/ja";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ChatGptHandoffInput,
  ChatGptTransferredProfile,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { codexAuthHandoffUrl } from "@t3tools/shared/codexAuthHandoff";
import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { Children, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import {
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
  useEnvironment,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";
import { ChatGptUsageButton } from "./ChatGptUsageButton";
import { ChatGptAccountPicker } from "./ChatGptAccountPicker";
import { Input } from "../ui/input";
import { OpenAI } from "../Icons";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow } from "./settingsLayout";
import { AddCodexAccountDialog } from "./AddCodexAccountDialog";
import { getOnboardingProviderState } from "../../onboarding/providerReadiness.logic";
import { getProviderSummary } from "./providerStatus";

const noop = () => undefined;

interface CodexSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly mode: "managed" | "existing";
  readonly enabled: boolean;
  readonly readOnly?: boolean;
  readonly presentation?: "settings" | "onboarding";
  readonly onModeChange: (mode: "managed" | "existing") => void;
  readonly autoStart?: boolean;
  readonly displayName?: string | undefined;
  readonly onAutoStartConsumed?: () => void;
  readonly onSignInCancelled?: (() => void) | undefined;
}

/** Welcome and provider settings run the same environment-owned setup flow. */
export function CodexSetupSection(props: CodexSetupSectionProps) {
  const [requested, setRequested] = useState(false);
  const existingState = getOnboardingProviderState(props.provider);
  const existingReady = props.enabled && existingState === "ready";
  const existingAuthenticated = props.provider?.auth.status === "authenticated";
  const existingChecking = existingState === "checking";
  const existingSummary = getProviderSummary(props.provider);
  const content =
    props.mode === "existing" && props.presentation === "onboarding" ? (
      <CodexWelcomeCard
        title={props.displayName || props.provider?.displayName || "Codex"}
        description={
          existingReady ? (
            props.provider?.auth.email?.trim() ? (
              <>
                ログイン済み{" "}
                <RedactedSensitiveText
                  value={props.provider.auth.email.trim()}
                  ariaLabel="アカウントのメールアドレス表示を切り替え"
                  revealTooltip="Click to reveal email"
                  hideTooltip="Click to hide email"
                  className="break-all"
                />
                .
              </>
            ) : (
              ja("Connected with your Codex CLI.")
            )
          ) : existingChecking ? (
            ja("Checking your Codex CLI...")
          ) : props.provider?.installed ? (
            existingSummary.headline
          ) : (
            ja("Code with your ChatGPT subscription.")
          )
        }
        control={
          existingReady ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
              <CheckIcon className="size-3.5" />
              準備完了
            </span>
          ) : existingChecking ? (
            <span className="text-xs text-muted-foreground">確認中…</span>
          ) : existingAuthenticated ? (
            <span className="text-xs text-muted-foreground">{ja(existingSummary.headline)}</span>
          ) : (
            <ChatGptConnectionButton
              size="sm"
              disabled={props.readOnly}
              onClick={() => {
                setRequested(true);
                props.onModeChange("managed");
              }}
            >
              ChatGPTで続ける
            </ChatGptConnectionButton>
          )
        }
        secondaryControl={
          !existingAuthenticated && !existingReady && !existingChecking ? (
            <Button size="sm" variant="ghost-muted" onClick={() => props.onModeChange("existing")}>
              既存のCLIを使う
            </Button>
          ) : null
        }
      />
    ) : props.mode === "existing" ? null : props.provider?.setup === undefined ? (
      props.presentation === "onboarding" ? (
        <CodexWelcomeCard
          title={props.displayName || props.provider?.displayName || "Codex"}
          description={<CodexSignInDescription />}
          control={
            <Button size="sm" variant="outline" className="min-w-44" disabled>
              ログインページを開く
            </Button>
          }
          secondaryControl={
            <Button size="sm" variant="ghost-muted" disabled>
              キャンセル
            </Button>
          }
        />
      ) : (
        <SettingsRow title="ChatGPTアカウント" description="ログインを準備しています。" />
      )
    ) : (
      <ManagedCodexSetup
        key={`${props.environmentId}:${props.instanceId}`}
        {...props}
        autoStart={requested || props.autoStart === true}
        onAutoStartConsumed={() => {
          setRequested(false);
          props.onAutoStartConsumed?.();
        }}
      />
    );
  return content;
}

/** All add-Codex entry points use the same managed account setup. */
export function AddManagedCodexAccountDialog({
  environmentId,
  onClose,
  onAccountCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onAccountCreated?:
    | ((instanceId: ProviderInstanceId, displayName: string) => void)
    | undefined;
}) {
  return (
    <AddCodexAccountDialog
      environmentId={environmentId}
      onClose={onClose}
      onAccountCreated={onAccountCreated}
      renderSetup={(instanceId, provider) => (
        <ManagedCodexSetup
          key={instanceId}
          environmentId={environmentId}
          instanceId={instanceId}
          provider={provider}
          mode="managed"
          enabled
          autoStart
          onAutoStartConsumed={noop}
          onModeChange={noop}
          onSignInCancelled={onClose}
          allowExistingCli={false}
        />
      )}
    />
  );
}

function ManagedCodexSetup({
  environmentId,
  instanceId,
  provider,
  enabled,
  readOnly,
  onModeChange,
  autoStart,
  onAutoStartConsumed,
  allowExistingCli = true,
  presentation,
  displayName,
  onSignInCancelled,
}: CodexSetupSectionProps & {
  readonly autoStart: boolean;
  readonly onAutoStartConsumed: () => void;
  readonly allowExistingCli?: boolean;
}) {
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const [handoff, setHandoff] = useState<{
    environmentId: EnvironmentId;
    input: ChatGptHandoffInput;
  } | null>(null);
  const handoffQuery = useEnvironmentQuery(
    handoff ? serverEnvironment.chatGptHandoffState(handoff) : null,
  );
  const auth = handoffQuery.data?.phase === "auth" ? handoffQuery.data.state : authQuery.data;
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [requestedMethodId, setRequestedMethodId] = useState("chatgpt");
  const reconnectEmail = auth?.methods?.find((method) => method.id === "chatgpt")?.accountEmail;
  const requestedAccountEmail = auth?.methods?.find(
    (method) => method.id === requestedMethodId,
  )?.accountEmail;
  const hasSavedAccount = auth?.methods?.some((method) => method.id.startsWith("chatgpt-profile:"));
  const url = auth?.interaction?.type === "browser" ? auth.interaction.url : auth?.authorizationUrl;
  const installation = installQuery.data;
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const local = httpBaseUrl !== null && isLoopbackHost(new URL(httpBaseUrl).hostname);
  const options = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, options);
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, options);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, options);
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, options);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, options);
  const reconnectProfile = useAtomCommand(serverEnvironment.chatGptReconnectProfile, options);
  const importProfile = useAtomCommand(serverEnvironment.chatGptImportProfile, options);
  const clientCallback =
    !handoff && (!local || window.desktopBridge?.receiveProviderAuthCallback !== undefined);
  const remoteWeb = clientCallback && !window.desktopBridge?.receiveProviderAuthCallback;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = useEnvironment(primaryEnvironmentId);
  const primaryHttpBaseUrl = useEnvironmentHttpBaseUrl(primaryEnvironmentId);
  const primaryAuthEnvironmentId =
    !local &&
    primaryEnvironmentId &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryHttpBaseUrl &&
    isLoopbackHost(new URL(primaryHttpBaseUrl).hostname) &&
    (window.desktopBridge !== undefined || isLoopbackHost(window.location.hostname))
      ? primaryEnvironmentId
      : null;
  const returnUrl = new URL(window.location.href);
  if (returnUrl.pathname === "/welcome") returnUrl.hash = `agents:${environmentId}`;
  if (returnUrl.pathname === "/settings/providers")
    returnUrl.searchParams.set("instanceId", instanceId);
  const needsManualCallback = remoteWeb;
  const callbackHelpId = useId();
  const [callbackHelpOpen, setCallbackHelpOpen] = useState(false);
  const [callbackDraft, setCallbackDraft] = useState({ flowId: "", value: "" });
  const callbackUrl = callbackDraft.flowId === auth?.flowId ? callbackDraft.value : "";
  const [pending, setPending] = useState(false);
  const [awaitingProvider, setAwaitingProvider] = useState<"sign-in" | "handoff" | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const continueWithSignIn = useRef<string | null>(null);
  const openRequested = useRef(false);
  const openedFlow = useRef<string | null>(null);
  const [autoStartHandled, setAutoStartHandled] = useState(false);
  const installed = installation?.installedVersion != null;
  const authenticated = provider?.auth.status === "authenticated";
  const updateAvailable =
    installed &&
    installation?.source !== "local" &&
    installation?.version != null &&
    installation.version !== installation.installedVersion;
  // Auth receipts and provider snapshots arrive independently. Keep the current
  // attempt pending until its authenticated snapshot arrives, even after success.
  const finishingSignIn =
    awaitingProvider !== null &&
    !authenticated &&
    (auth?.phase === "succeeded" || awaitingProvider === "handoff");
  useEffect(() => {
    if (authenticated || auth?.phase === "failed" || auth?.phase === "cancelled") {
      setAwaitingProvider(null);
    }
  }, [authenticated, auth?.phase]);
  useEffect(() => {
    if (awaitingProvider && auth?.phase === "succeeded") {
      void refreshProviders({ environmentId, input: { instanceId } });
    }
  }, [awaitingProvider, auth?.phase, refreshProviders, environmentId, instanceId]);
  const startingAutomatically = autoStart && !autoStartHandled;
  const waitingForAuthState =
    awaitingProvider === "sign-in" && !authenticated && (auth === null || auth.phase === "idle");
  const authInProgress =
    finishingSignIn ||
    waitingForAuthState ||
    handoff !== null ||
    auth?.phase === "starting" ||
    auth?.phase === "waiting" ||
    auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const authActive = startingAutomatically || authInProgress || (pending && !installActive);
  const unavailable =
    readOnly || !enabled || pending || authQuery.error !== null || installQuery.error !== null;
  const busy = pending || authInProgress || installActive;

  const run = useCallback(
    async <A, E>(
      request: () => Promise<AtomCommandResult<A, E>>,
      onSuccess?: (value: A) => void,
    ) => {
      if (pendingRef.current) return false;
      pendingRef.current = true;
      setPending(true);
      setError(null);
      let succeeded = false;
      try {
        const result = await request();
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setError(failure instanceof Error ? failure.message : "Codex setup failed. Try again.");
          }
        } else {
          succeeded = true;
          onSuccess?.(result.value);
        }
      } catch {
        setError("Codex setup failed. Try again.");
      }
      pendingRef.current = false;
      setPending(false);
      return succeeded;
    },
    [],
  );

  const handoffId = useId();
  const handoffSequence = useRef(0);
  const importedAttempt = useRef<string | null>(null);
  const [transferFailed, setTransferFailed] = useState(false);
  const transferProfile = useCallback(
    async (profile: ChatGptTransferredProfile) => {
      const succeeded = await run(() =>
        importProfile({ environmentId, input: { instanceId, profile } }),
      );
      if (succeeded) {
        setAwaitingProvider("handoff");
        setHandoff(null);
      }
      setTransferFailed(!succeeded);
    },
    [run, importProfile, environmentId, instanceId],
  );
  useEffect(() => {
    if (!handoff || handoffQuery.data?.phase !== "finished") return;
    const attemptId = handoff.input.attemptId;
    if (importedAttempt.current === attemptId) return;
    importedAttempt.current = attemptId;
    void transferProfile(handoffQuery.data.profile);
  }, [handoff, handoffQuery.data, transferProfile]);
  useEffect(() => {
    if (!handoff) return;
    if (
      handoffQuery.error ||
      (handoffQuery.data?.phase === "auth" &&
        ["failed", "cancelled"].includes(handoffQuery.data.state.phase))
    ) {
      setError(
        handoffQuery.data?.phase === "auth"
          ? (handoffQuery.data.state.message ?? "ChatGPT sign-in could not finish. Try again.")
          : "ChatGPT sign-in on the primary environment was interrupted. Try again.",
      );
      setHandoff(null);
    }
  }, [handoff, handoffQuery.data, handoffQuery.error]);
  const cancelSignIn = useCallback(() => {
    setAwaitingProvider(null);
    if (handoff) {
      setHandoff(null);
      return Promise.resolve();
    }
    return run(() => cancelAuth({ environmentId, input: { instanceId, flowId: auth!.flowId! } }));
  }, [handoff, run, cancelAuth, environmentId, instanceId, auth]);

  const signIn = useCallback(
    async (methodId = "chatgpt") => {
      if (pendingRef.current) return;
      openRequested.current = true;
      setTransferFailed(false);
      setRequestedMethodId(methodId);
      const returnUrl = new URL(window.location.href);
      if (returnUrl.pathname === "/welcome") returnUrl.hash = `agents:${environmentId}`;
      if (returnUrl.pathname === "/settings/providers")
        returnUrl.searchParams.set("instanceId", instanceId);
      if (primaryAuthEnvironmentId) {
        const attemptId = `${handoffId}:${++handoffSequence.current}`;
        const succeeded = await run(
          () => reconnectProfile({ environmentId, input: { instanceId, methodId } }),
          (profile) =>
            setHandoff({
              environmentId: primaryAuthEnvironmentId,
              input: {
                instanceId,
                environmentId,
                attemptId,
                returnUrl: returnUrl.toString(),
                profile,
              },
            }),
        );
        if (!succeeded) openRequested.current = false;
        return;
      }
      if (
        !(await run(
          () =>
            startAuth({
              environmentId,
              input: {
                instanceId,
                methodId,
                returnUrl: returnUrl.toString(),
                callbackMode: clientCallback ? "client" : "server",
              },
            }),
          () => setAwaitingProvider("sign-in"),
        ))
      ) {
        openRequested.current = false;
      }
    },
    [
      environmentId,
      instanceId,
      run,
      startAuth,
      clientCallback,
      primaryAuthEnvironmentId,
      reconnectProfile,
      handoffId,
    ],
  );

  const setup = useCallback(
    async (methodId = "chatgpt") => {
      if (unavailable || busy) return;
      if (installed && !updateAvailable) {
        await signIn(methodId);
      } else {
        continueWithSignIn.current = methodId;
        if (!(await run(() => startInstall({ environmentId, input: { instanceId } })))) {
          continueWithSignIn.current = null;
        }
      }
    },
    [
      unavailable,
      busy,
      installed,
      updateAvailable,
      signIn,
      run,
      startInstall,
      environmentId,
      instanceId,
    ],
  );

  useEffect(() => {
    if (
      !autoStart ||
      autoStartHandled ||
      unavailable ||
      busy ||
      installation === null ||
      !provider?.setup?.canInstall
    )
      return;
    setAutoStartHandled(true);
    onAutoStartConsumed();
    void setup();
  }, [
    autoStart,
    autoStartHandled,
    unavailable,
    busy,
    installation,
    provider?.setup?.canInstall,
    onAutoStartConsumed,
    setup,
  ]);

  useEffect(() => {
    if (!continueWithSignIn.current || pending || installActive) return;
    if (installation?.phase === "failed" || installation?.phase === "cancelled") {
      continueWithSignIn.current = null;
    } else if (installed) {
      const methodId = continueWithSignIn.current;
      continueWithSignIn.current = null;
      void signIn(methodId);
    }
  }, [pending, installActive, installation?.phase, installed, signIn]);

  const receivingCallback = useRef<string | null>(null);
  const flowId = auth?.flowId;
  const openPage = useCallback(
    async (authorizationUrl: string) => {
      try {
        const receive = window.desktopBridge?.receiveProviderAuthCallback;
        if (receive && clientCallback && flowId) {
          if (receivingCallback.current === authorizationUrl) {
            await ensureLocalApi().shell.openExternal(authorizationUrl);
            return;
          }
          receivingCallback.current = authorizationUrl;
          const callbackUrl = await receive(authorizationUrl);
          if (receivingCallback.current !== authorizationUrl) return;
          receivingCallback.current = null;
          await run(() =>
            completeAuth({ environmentId, input: { instanceId, flowId, callbackUrl } }),
          );
        } else {
          await ensureLocalApi().shell.openExternal(authorizationUrl);
        }
      } catch {
        setError(
          "Could not finish sign-in on this computer. Try again or paste the redirect URL below.",
        );
      }
    },
    [clientCallback, flowId, run, completeAuth, environmentId, instanceId],
  );

  useEffect(() => {
    if (!clientCallback || !url || !window.desktopBridge?.cancelProviderAuthCallback) return;
    return () => {
      if (receivingCallback.current === url) receivingCallback.current = null;
      void window.desktopBridge?.cancelProviderAuthCallback?.(url).catch(() => undefined);
    };
  }, [clientCallback, url]);

  useEffect(() => {
    if (
      !openRequested.current ||
      auth?.phase !== "waiting" ||
      !auth.flowId ||
      !url ||
      openedFlow.current === auth.flowId
    )
      return;
    openedFlow.current = auth.flowId;
    openRequested.current = false;
    if (!remoteWeb) void openPage(url);
  }, [auth?.phase, auth?.flowId, url, openPage, remoteWeb]);

  const runtimeDescription =
    installation?.phase === "downloading"
      ? `Downloading ${(installation.downloadedBytes / 1_000_000).toFixed(1)}${installation.totalBytes === null ? "" : ` of ${(installation.totalBytes / 1_000_000).toFixed(1)}`} MB.`
      : installation?.phase === "extracting"
        ? "Installing Codex."
        : installation?.phase === "verifying"
          ? "Checking Codex."
          : installed
            ? `${installation?.source === "local" ? "Using your installed Codex" : "Managed by T3 Code"}${installation?.installedVersion ? ` · v${installation.installedVersion}` : ""}.`
            : (installation?.message ?? "T3 Code downloads and manages Codex for you.");
  const accountDescription = finishingSignIn ? (
    "Finishing sign-in..."
  ) : installActive ? (
    runtimeDescription
  ) : authActive || auth?.phase === "failed" || auth?.phase === "cancelled" ? (
    auth?.phase === "waiting" && requestedAccountEmail ? (
      `Continue as ${requestedAccountEmail} on OpenAI.`
    ) : (
      (auth?.message ?? "Finish signing in in your browser.")
    )
  ) : authenticated ? (
    provider?.auth.email?.trim() ? (
      <>
        ログイン済み{" "}
        <RedactedSensitiveText
          value={provider.auth.email.trim()}
          ariaLabel="アカウントのメールアドレス表示を切り替え"
          revealTooltip="Click to reveal email"
          hideTooltip="Click to hide email"
        />
        .
      </>
    ) : (
      "Signed in with ChatGPT."
    )
  ) : (
    (reconnectEmail ?? "Use your ChatGPT subscription.")
  );

  const handoffUrl =
    needsManualCallback && url && auth?.flowId && providerAuthReturnUrl(returnUrl.toString())
      ? codexAuthHandoffUrl(
          {
            authorizationUrl: url,
            returnUrl: returnUrl.toString(),
            environmentId,
            instanceId,
            flowId: auth.flowId,
          },
          import.meta.env.DEV,
        )
      : null;
  const waitingControl = (
    <Button
      size="sm"
      variant={remoteWeb ? ja("default") : "outline"}
      className={presentation === "onboarding" ? "min-w-44" : undefined}
      disabled={
        handoffQuery.data?.phase === "finished"
          ? pending || !transferFailed
          : !url || auth?.phase !== "waiting"
      }
      onClick={() => {
        if (handoffQuery.data?.phase === "finished")
          void transferProfile(handoffQuery.data.profile);
        else if (url) void openPage(url);
      }}
    >
      {finishingSignIn
        ? "ログインを完了中…"
        : handoffQuery.data?.phase === "finished"
          ? transferFailed
            ? "接続を再試行"
            : "ログインを完了中…"
          : auth?.phase === "waiting"
            ? remoteWeb
              ? "ChatGPTのログイン画面を開く"
              : "ログインページを開く"
            : presentation === "onboarding"
              ? "ログインページを開く"
              : "ログイン中…"}
    </Button>
  );
  const callbackCompletion =
    !handoff && auth?.phase === "waiting" && url ? (
      <div className="flex w-full flex-col gap-3 text-xs leading-relaxed text-muted-foreground">
        <p>
          ログイン後にT3
          Codeへ戻らない場合は、最後に表示されたlocalhostページのURLを貼り付けてください。
        </p>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (!auth.flowId || !callbackUrl.trim()) return;
            const value = callbackUrl.trim();
            const submittedFlowId = auth.flowId;
            void run(() =>
              completeAuth({
                environmentId,
                input: { instanceId, flowId: submittedFlowId, callbackUrl: value },
              }),
            ).then((connected) => {
              if (connected) setCallbackDraft({ flowId: submittedFlowId, value: "" });
            });
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              aria-label="ChatGPTログインの転送先URL"
              type="password"
              autoComplete="off"
              placeholder="ログインタブのURLを貼り付けてください"
              value={callbackUrl}
              maxLength={16_384}
              disabled={pending || readOnly}
              onChange={(event) =>
                setCallbackDraft({ flowId: auth.flowId ?? "", value: event.target.value })
              }
            />
          </div>
          <Button
            variant="outline"
            type="submit"
            disabled={pending || readOnly || !callbackUrl.trim()}
          >
            接続
          </Button>
        </form>
        {!remoteWeb ? (
          <div>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void ensureLocalApi().shell.openExternal(url)}
            >
              ブラウザでログインを試す
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
        {handoffUrl ? (
          <details>
            <summary className="cursor-pointer">その他の接続方法</summary>
            <Button className="mt-2" size="sm" variant="outline" render={<a href={handoffUrl} />}>
              T3のデスクトップ版を使うと自動で戻ります
            </Button>
          </details>
        ) : null}
      </div>
    ) : null;
  const callbackHelpContent =
    callbackCompletion && callbackHelpOpen ? (
      <div id={callbackHelpId} className="w-full border-t border-border/50 pt-3">
        {ja(callbackCompletion)}
      </div>
    ) : null;
  const callbackFallback = needsManualCallback ? (
    callbackCompletion
  ) : callbackCompletion ? (
    <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
      <CodexSignInDescription
        label="ログインできない場合"
        expanded={callbackHelpOpen}
        controls={callbackHelpId}
        onToggle={() => setCallbackHelpOpen((open) => !open)}
      />
      {ja(callbackHelpContent)}
    </div>
  ) : null;

  const accountPicker = (
    <ChatGptAccountPicker
      open={accountPickerOpen}
      methods={auth?.methods ?? []}
      onClose={() => setAccountPickerOpen(false)}
      onSelect={(methodId) => {
        setAccountPickerOpen(false);
        void setup(
          auth?.methods?.some((method) => method.id === methodId)
            ? methodId
            : "chatgpt-change-account",
        );
      }}
    />
  );

  const logoutWarning =
    auth?.phase === "idle" && auth.message?.startsWith("Signed out locally.") ? auth.message : null;

  if (presentation === "onboarding") {
    const setupError =
      logoutWarning ??
      error ??
      (authQuery.error || installQuery.error
        ? "Could not read setup status. Reconnect and try again."
        : installation?.phase === "failed"
          ? installation.message
          : null);
    return (
      <>
        {ja(accountPicker)}
        <CodexWelcomeCard
          title={displayName || provider?.displayName || "Codex"}
          description={
            installActive ? (
              runtimeDescription
            ) : authenticated ? (
              provider?.auth.email?.trim() ? (
                <>
                  ログイン済み{" "}
                  <RedactedSensitiveText
                    value={provider.auth.email.trim()}
                    ariaLabel="アカウントのメールアドレス表示を切り替え"
                    revealTooltip="Click to reveal email"
                    hideTooltip="Click to hide email"
                    className="break-all"
                  />
                  .
                </>
              ) : (
                ja("Connected to ChatGPT.")
              )
            ) : callbackCompletion && !needsManualCallback ? (
              <CodexSignInDescription
                expanded={callbackHelpOpen}
                controls={callbackHelpId}
                onToggle={() => setCallbackHelpOpen((open) => !open)}
              />
            ) : startingAutomatically ||
              waitingForAuthState ||
              auth?.phase === "starting" ||
              auth?.phase === "waiting" ||
              (pending && !installActive) ? (
              <CodexSignInDescription />
            ) : authActive || auth?.phase === "failed" || auth?.phase === "cancelled" ? (
              accountDescription
            ) : (
              ja("Code with your ChatGPT subscription.")
            )
          }
          control={
            authenticated && !busy ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                <CheckIcon className="size-3.5" />
                準備完了
              </span>
            ) : authActive ? (
              waitingControl
            ) : (
              <ChatGptConnectionButton
                size="sm"
                disabled={
                  unavailable ||
                  busy ||
                  (!installed ? !provider?.setup?.canInstall : !provider?.setup?.canAuthenticate)
                }
                onClick={() => {
                  if (hasSavedAccount) setAccountPickerOpen(true);
                  else void setup();
                }}
              >
                {installActive || pending
                  ? "設定中…"
                  : hasSavedAccount
                    ? "アカウントを再接続"
                    : "ChatGPTで続ける"}
              </ChatGptConnectionButton>
            )
          }
          secondaryControl={
            (authActive && !finishingSignIn) || installActive ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={pending || readOnly}
                onClick={() => {
                  openRequested.current = false;
                  continueWithSignIn.current = null;
                  if (handoff || (authActive && auth?.flowId)) void cancelSignIn();
                  else if (installation?.operationId)
                    void run(() =>
                      cancelInstall({
                        environmentId,
                        input: { instanceId, operationId: installation.operationId! },
                      }),
                    );
                }}
              >
                キャンセル
              </Button>
            ) : !authActive && !authenticated && hasSavedAccount ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={unavailable || busy}
                onClick={() => void setup("chatgpt-change-account")}
              >
                別のアカウントを使う
              </Button>
            ) : !authActive && !authenticated && allowExistingCli ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={readOnly || busy}
                onClick={() => onModeChange("existing")}
              >
                既存のCLIを使う
              </Button>
            ) : null
          }
        >
          {needsManualCallback ? callbackFallback : callbackHelpContent}
          {setupError ? (
            <p role="alert" className="text-xs text-destructive">
              {ja(setupError)}
            </p>
          ) : null}
        </CodexWelcomeCard>
      </>
    );
  }

  return (
    <section aria-label="Codexの設定" className="divide-y divide-border/50">
      {ja(accountPicker)}
      <SettingsRow
        title="ChatGPTアカウント"
        description={ja(accountDescription)}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {authActive ? (
              <>
                {ja(waitingControl)}
                {ja(
                  !finishingSignIn && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || readOnly}
                      onClick={() => {
                        if (!handoff && !auth?.flowId) return;
                        openRequested.current = false;
                        void cancelSignIn();
                        onSignInCancelled?.();
                      }}
                    >
                      キャンセル
                    </Button>
                  ),
                )}
              </>
            ) : installActive ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending || readOnly}
                onClick={() => {
                  if (!installation?.operationId) return;
                  continueWithSignIn.current = null;
                  void run(() =>
                    cancelInstall({
                      environmentId,
                      input: { instanceId, operationId: installation.operationId! },
                    }),
                  );
                }}
              >
                キャンセル
              </Button>
            ) : authenticated ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={unavailable || busy}
                  onClick={() => setAccountPickerOpen(true)}
                >
                  アカウントを変更
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={unavailable || busy}
                  onClick={() => void run(() => logoutAuth(target))}
                >
                  切断
                </Button>
              </>
            ) : (
              <>
                <ChatGptConnectionButton
                  size="sm"
                  disabled={
                    unavailable ||
                    busy ||
                    (!installed ? !provider?.setup?.canInstall : !provider?.setup?.canAuthenticate)
                  }
                  onClick={() => {
                    if (hasSavedAccount) setAccountPickerOpen(true);
                    else void setup();
                  }}
                >
                  {pending ? "設定中…" : hasSavedAccount ? "アカウントを再接続" : "ChatGPTで続ける"}
                </ChatGptConnectionButton>
                {hasSavedAccount ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={unavailable || busy}
                    onClick={() => void setup("chatgpt-change-account")}
                  >
                    別のアカウントを使う
                  </Button>
                ) : null}
              </>
            )}
          </div>
        }
      />
      {authenticated ? (
        <div className="flex justify-end px-3 py-1 sm:px-4">
          <ChatGptUsageButton />
        </div>
      ) : null}
      {logoutWarning ? (
        <p role="alert" className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          {ja(logoutWarning)}
        </p>
      ) : null}
      {callbackFallback ? <div className="px-3 py-3 sm:px-4">{ja(callbackFallback)}</div> : null}
      {error || authQuery.error || installQuery.error || installation?.phase === "failed" ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive sm:px-4">
          {ja(
            error ??
              (installation?.phase === "failed"
                ? installation.message
                : "Could not read Codex setup status. Reconnect and try again."),
          )}
        </p>
      ) : null}
    </section>
  );
}

/** The server selects the executable for managed instances; local config cannot override it. */
export function CodexManagedRuntimeFields({
  environmentId,
  instanceId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
}) {
  const installation = useEnvironmentQuery(
    serverEnvironment.providerInstallState({
      environmentId,
      input: { instanceId },
    }),
  );
  const executablePath = installation.data?.executablePath ?? "";
  return (
    <>
      <SettingsRow
        title="実行ファイルのパス"
        description="T3 Codeが選択しました。"
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label="Codex実行ファイルのパス"
              value={executablePath}
              title={ja(executablePath)}
              placeholder={
                installation.error ? "実行環境のパスを読み取れませんでした" : "未インストール"
              }
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title="CODEX_HOMEのパス"
        description="共有するCodexの設定・セッション・状態です。"
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label="Codexのデータフォルダ"
              value={provider?.runtimePaths?.homePath ?? ""}
              title={ja(provider?.runtimePaths?.homePath)}
              placeholder="利用できません"
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title="アカウント用データフォルダ"
        description={
          provider?.runtimePaths?.shadowHomePath
            ? "上のCodexの状態を共有する、アカウント専用のフォルダです。"
            : "この接続は共有のCodexフォルダを直接使います。"
        }
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label="Codexのアカウント専用フォルダ"
              value={provider?.runtimePaths?.shadowHomePath ?? ""}
              title={ja(provider?.runtimePaths?.shadowHomePath ?? undefined)}
              placeholder={provider?.runtimePaths ? "未使用" : "利用できません"}
              disabled
            />
          </div>
        }
      />
    </>
  );
}

function CodexSignInDescription({
  label = "Complete sign-in in your browser.",
  expanded = false,
  controls,
  onToggle,
}: {
  readonly label?: string;
  readonly expanded?: boolean;
  readonly controls?: string;
  readonly onToggle?: () => void;
}) {
  if (!onToggle) return <div className="leading-relaxed">{ja(label)}</div>;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-sm text-left leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="ログインできない場合"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {ja(label)}
      <ChevronRightIcon aria-hidden className={`size-3 shrink-0 ${expanded ? "rotate-90" : ""}`} />
    </button>
  );
}

/** A single, calm setup row for the first-run welcome screen. */
function CodexWelcomeCard({
  title,
  description,
  control,
  secondaryControl,
  children,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly control?: ReactNode;
  readonly secondaryControl?: ReactNode;
  readonly children?: ReactNode;
}) {
  const footer = Children.toArray(children);
  return (
    <div className="rounded-lg border border-border bg-background px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <OpenAI className="size-5 shrink-0 fill-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{ja(title)}</h3>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {ja(description)}
          </div>
        </div>
        {control || secondaryControl ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 has-[button]:w-full has-[button]:flex-col-reverse has-[button]:items-end sm:has-[button]:w-auto sm:has-[button]:flex-row sm:has-[button]:items-center">
            {ja(secondaryControl)}
            {ja(control)}
          </div>
        ) : null}
      </div>
      {footer.length > 0 ? (
        <div className="ml-8 mt-2 flex flex-wrap items-center gap-2">{ja(footer)}</div>
      ) : null}
    </div>
  );
}
