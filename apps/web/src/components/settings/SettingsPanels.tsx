import { ja, jaTemplate } from "../../lib/ja";
import { SettingsGroup } from "./SettingsGroup";
import { Spinner } from "~/components/ui/spinner";
import { NotificationSettings } from "./NotificationSettings";
import { ArchiveIcon, ArchiveX, CheckIcon, ChevronRightIcon, SettingsIcon } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BackgroundActivityProfile,
  type DesktopUpdateChannel,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type DiffLayout,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MAX_PROMPT_FONT_SIZE,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PANEL_ANIMATION_DURATION_MS,
  MIN_PROMPT_FONT_SIZE,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ResponseStreamingMode,
  MIN_TERMINAL_FONT_SIZE,
  type QuitConfirmationMode,
} from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ATTACH_BY_REFERENCE_OPTIONS } from "../chat/attachByReference";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { isElectron } from "../../env";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import { DelegationSettings } from "./DelegationSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  resolveDefaultFamilyLabel,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../../appearanceFonts";
import { CodeFontPreview, PromptFontPreview, TerminalFontPreview } from "./SettingsFontPreviews";
import { discoverInstalledFonts, FontFamilyPicker, useFontEnumeration } from "./FontFamilyPicker";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThemeLibrary } from "./ThemeSettings";
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTarget,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork",
  pill: "Version pill",
  none: "None",
};

const RESPONSE_STREAMING_MODE_LABELS: Record<ResponseStreamingMode, string> = {
  turn: "Wait for the full response",
  paragraph: "Show finished paragraphs",
  token: "Token by token (legacy)",
};

const RESPONSE_STREAMING_MODE_DESCRIPTIONS: Record<ResponseStreamingMode, string> = {
  turn: "Text appears once the agent finishes its turn.",
  paragraph: "Each paragraph or code block appears as soon as it is complete.",
  token:
    "Every token repaints the answer as it arrives. Slower and harder to read. Thinking traces still arrive a paragraph at a time.",
};

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full",
};

const DIFF_LAYOUT_LABELS: Record<DiffLayout, string> = {
  stacked: "Stacked",
  split: "Split",
};

const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, string> = {
  direct: "Direct",
  hold: "Hold",
  "double-click": "Double press",
};

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: "Balanced",
  performance: "Performance",
  "battery-saver": "Battery saver",
};

type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<BackgroundActivityProfileOption, string> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
  advanced: "Advanced",
};

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced: "Pauses probes for idle clients, locked hosts, or low power mode.",
  performance: "Allows scoped background probes while any subscribed client remains connected.",
  "battery-saver": "Also pauses background probes when the host or client is on battery.",
};

const ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION = "Uses custom intervals.";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly label: string;
}> = [
  { key: "pauseWhenHostLocked", label: "Pause when host is locked" },
  { key: "pauseWhenHostLowPower", label: "Pause on host low power" },
  { key: "pauseWhenClientLowPower", label: "Pause on client low power" },
  { key: "pauseWhenOnBattery", label: "Pause on battery" },
];

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>バージョン</span>
      <code className="text-2xs font-medium text-muted-foreground">{ja(APP_VERSION)}</code>
    </span>
  );
}

function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      setIsUpdateActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
        );
      } catch (error) {
        setIsUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        })
        .finally(() => setIsUpdateActionPending(false));
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [isUpdateActionPending, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={ja(description)}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={buttonDisabled || isUpdateActionPending}
                  onClick={handleButtonClick}
                >
                  {ja(buttonLabel)}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{ja(buttonTooltip)}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="更新チャンネル"
          description="安定版または開発版を使います。いつでも切り替えられます。"
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="更新チャンネル"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "開発版" : "安定版"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  安定版
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  開発版
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          title="更新チャンネル"
          description="Web版アプリの更新チャンネルを切り替えます。"
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="更新チャンネル">
                <SelectValue>{ja(HOSTED_APP_CHANNEL_LABEL)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  最新
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  開発版
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(!followSystem ? ["Follow system"] : []),
      ...(themeHalves !== null ? ["Theme mix"] : []),
      ...(settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast
        ? ["Contrast"]
        : []),
      ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ["Glass opacity"] : []),
      ...(settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme
        ? ["Diff colors"]
        : []),
      ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? ["Chat width"] : []),
      ...(settings.panelAnimationDurationMs !== DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs
        ? ["Panel animations"]
        : []),
      ...(settings.environmentIdentificationMode !==
      DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
        ? ["Environment identification"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.notificationMode !== DEFAULT_UNIFIED_SETTINGS.notificationMode
        ? ["Thread notifications"]
        : []),
      ...(settings.inAppNotificationsEnabled !== DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled
        ? ["In-app notifications"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["Visible threads"]
        : []),
      ...(settings.sidebarProjectGroupingMode !==
      DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
        ? ["Project Grouping"]
        : []),
      ...(settings.sidebarAutoSettleAfterDays !==
      DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
        ? ["Auto-settle inactive threads"]
        : []),
      ...(settings.sidebarAutoSettleOnMerge !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge
        ? ["Auto-settle merged threads"]
        : []),
      ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),
      ...getChangedTypographySettingLabels(settings),
      ...(settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed
        ? ["Default diff file state"]
        : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? ["Diff layout"] : []),
      ...(settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled
        ? ["Proactive panels"]
        : []),
      ...(settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu
        ? ["Show skills in slash menu"]
        : []),
      ...(settings.composerCollapseOnScroll !== DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll
        ? ["Collapse composer on scroll"]
        : []),
      ...(settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled
        ? ["Rich text composer"]
        : []),
      ...(settings.attachByReference !== DEFAULT_UNIFIED_SETTINGS.attachByReference
        ? ["大きいファイルは元の場所を参照して添付する"]
        : []),
      ...(settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? ["Send shortcut"] : []),
      ...(settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior
        ? ["Follow-up behavior"]
        : []),
      ...(settings.contextWindowMeterEnabled !== DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled
        ? ["Context window indicator"]
        : []),
      ...(settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode
        ? ["Response streaming"]
        : []),
      ...(settings.enableProviderUpdateChecks !==
      DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
        ? ["Provider update checks"]
        : []),
      ...(settings.continueThreadsAfterServerUpdate !==
      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate
        ? ["Continue threads after restarts"]
        : []),
      ...(isBackgroundActivityDirty ? ["Background activity"] : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.newWorktreesStartFromOrigin !==
      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
        ? ["New worktrees start from origin"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin
        ? ["Unpin confirmation"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? ["Quit shortcut"] : []),
      ...(isTextGenerationModelDirty ? ["Text generation model"] : []),
      ...getChangedBrowserSettingLabels(settings),
      ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
        ? ["Agent browser access"]
        : []),
    ],
    [
      isTextGenerationModelDirty,
      isBackgroundActivityDirty,
      settings.browserDefaultViewport,
      settings.browserDefaultZoomFactor,
      settings.browserDefaultAppearance,
      settings.browserRecordingFrameRate,
      settings.browserRecordingShowKeyPresses,
      settings.browserRecordingShowMousePresses,
      settings.browserLinkTarget,
      settings.browserAutoShowFloatingPreview,
      settings.appearanceContrast,
      settings.diffColorScheme,
      settings.chatWidth,
      settings.enableAgentBrowserAccess,
      settings.confirmQuit,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.confirmThreadUnpin,
      settings.composerCollapseOnScroll,
      settings.composerRichTextEnabled,
      settings.attachByReference,
      settings.sendShortcut,
      settings.followUpBehavior,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
      settings.diffFilesCollapsed,
      settings.diffIgnoreWhitespace,
      settings.diffLayout,
      settings.proactivePanelsEnabled,
      settings.environmentIdentificationMode,
      settings.contextWindowMeterEnabled,
      settings.fontFamilyCode,
      settings.fontFamilyComposer,
      settings.fontFamilySans,
      settings.fontFamilyTerminal,
      settings.fontSizeCode,
      settings.fontSizeInterface,
      settings.fontSizePrompt,
      settings.fontSizeTerminal,
      settings.glassOpacity,
      settings.panelAnimationDurationMs,
      settings.responseStreamingMode,
      settings.enableProviderUpdateChecks,
      settings.continueThreadsAfterServerUpdate,
      settings.sidebarAutoSettleAfterDays,
      settings.sidebarAutoSettleOnMerge,
      settings.sidebarProjectGroupingMode,
      settings.sidebarThreadPreviewCount,
      settings.showSkillsInSlashMenu,
      settings.timestampFormat,
      settings.notificationMode,
      settings.inAppNotificationsEnabled,
      settings.wordWrap,
      followSystem,
      theme,
      themeHalves,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      [
        ja("Restore default settings?"),
        `This will reset: ${changedSettingLabels.join(", ")}.`,
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;

    // Only touch the theme keys that are actually dirty, so a theme-storage
    // failure cannot block restoring unrelated settings. Preferences are
    // re-read after the confirmation dialog: they may have changed (another
    // tab, an OS flip) while it was open, and rollback must restore the live
    // values rather than the ones captured at render time.
    let previousTheme = theme;
    try {
      previousTheme = readThemePreference();
    } catch {
      // Storage is unreadable; the render-time value is the best rollback.
    }
    // The mix may have changed while the confirmation dialog was open; both
    // the dirty check and the rollback must see the live value.
    const liveHalves = readThemeHalves();
    const needsThemeReset = previousTheme !== "system";
    const needsMixReset = liveHalves !== null;
    // Same for the appearance mode: trusting the render-time value would skip
    // the reset and report success while a non-system mode stayed in storage.
    const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
    const notifyThemeRestoreFailure = () => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn’t restore theme settings",
          description: "Try again.",
        }),
      );
    };
    // Rollback restores the base preference first (which clears any mix) and
    // then re-applies the captured mix on top, so no failure path can leave
    // the pair of keys half-restored.
    const previousHalves = liveHalves;
    const rollbackThemeState = () => {
      if (needsThemeReset) setTheme(previousTheme);
      if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
      if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
    };
    if (needsThemeReset && !setTheme("system")) {
      notifyThemeRestoreFailure();
      return;
    }
    if (needsMixReset && !clearThemeHalves()) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    if (needsFollowSystemReset && !setFollowSystem(true)) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    updateSettings({
      appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
      diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
      chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      notificationMode: DEFAULT_UNIFIED_SETTINGS.notificationMode,
      inAppNotificationsEnabled: DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout,
      proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
      composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
      composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
      attachByReference: DEFAULT_UNIFIED_SETTINGS.attachByReference,
      sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut,
      followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
      contextWindowMeterEnabled: DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
      sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
      responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      continueThreadsAfterServerUpdate: DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
      confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
      fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
      fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
      fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
      fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
      fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
      fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
      fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
      browserDefaultViewport: DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
      browserDefaultZoomFactor: DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor,
      browserDefaultAppearance: DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance,
      browserRecordingFrameRate: DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate,
      browserRecordingShowKeyPresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowKeyPresses,
      browserRecordingShowMousePresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowMousePresses,
      browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget,
      browserAutoShowFloatingPreview: DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
      // Re-granted like any other default. The confirmation dialog lists it by
      // name, so a user restoring defaults is told the agent regains access
      // rather than discovering it later.
      enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
    });
    onRestored?.();
  }, [
    changedSettingLabels,
    clearThemeHalves,
    onRestored,
    setFollowSystem,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
    updateSettings,
  ]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

/**
 * Gate in front of the legacy token-by-token mode. The primary action steers
 * the user to paragraph streaming; the legacy path is the quiet option.
 */
function TokenStreamingWarningDialog({
  open,
  onOpenChange,
  onConfirm,
  onUseParagraphs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onUseParagraphs: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>文字ごとの表示は動作が重くなります</AlertDialogTitle>
          <AlertDialogDescription>
            文字が届くたびに描画するため、動作が遅く読みにくくなり、接続中の各デバイスのCPU負荷も増えます。互換用の旧方式です。段落ごとの表示をおすすめします。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost-muted" className="sm:mr-auto" onClick={onConfirm}>
            文字ごとに表示する
          </Button>
          <AlertDialogClose render={<Button variant="outline" />}>キャンセル</AlertDialogClose>
          <Button onClick={onUseParagraphs}>段落ごとに表示する</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>バックグラウンド動作</DialogTitle>
          <DialogDescription>
            共通の電源条件とバックグラウンドの確認間隔を設定します。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">共通の条件</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  確認のタイマーが動いたとき、バックグラウンド処理を実行するか決めます。
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="共通のバックグラウンド条件"
                >
                  <SelectValue>{ja(BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {ja(BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced)}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {ja(BACKGROUND_ACTIVITY_PROFILE_LABELS.performance)}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {ja(BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"])}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {ja(searchableSetting("git-fetch-interval").title)}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  バックグラウンドでリモートブランチの状態を更新します。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          automaticGitFetchInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Gitの確認間隔を短くする" />
                    <NumberFieldInput aria-label="Gitの確認間隔（秒）" />
                    <NumberFieldIncrement aria-label="Gitの確認間隔を長くする" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">エージェントの確認間隔</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  エージェントの利用可否・バージョン・認証状態・モデル情報を更新します。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          providerHealthRefreshInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="エージェントの確認間隔を短くする" />
                    <NumberFieldInput aria-label="エージェントの確認間隔（秒）" />
                    <NumberFieldIncrement aria-label="エージェントの確認間隔を長くする" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">パソコンの電源状態の確認</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  クライアントの操作中に、パソコンの電源状態を確認します。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorActiveInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="操作中の電源確認の間隔を短くする" />
                    <NumberFieldInput aria-label="操作中の電源確認の間隔（秒）" />
                    <NumberFieldIncrement aria-label="操作中の電源確認の間隔を長くする" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">待機中のパソコンの確認</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  操作中のクライアントがないとき、パソコンの電源状態を確認します。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorIdleInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="待機中の電源確認の間隔を短くする" />
                    <NumberFieldInput aria-label="待機中の電源確認の間隔（秒）" />
                    <NumberFieldIncrement aria-label="待機中の電源確認の間隔を長くする" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {ja(
                BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label }) => (
                  <label
                    key={key}
                    className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-r sm:even:border-r-0"
                  >
                    <span className="text-sm font-medium">{ja(label)}</span>
                    <Switch
                      checked={resolvedBackgroundActivity[key]}
                      onCheckedChange={(checked) =>
                        updateSettings(
                          backgroundActivityOverrideSettings(
                            settings.backgroundActivity,
                            resolvedBackgroundActivity,
                            {
                              [key]: Boolean(checked),
                            },
                          ),
                        )
                      }
                      aria-label={ja(label)}
                    />
                  </label>
                )),
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            すべてリセット
          </Button>
          <Button onClick={() => onOpenChange(false)}>完了</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function AppearanceSettingsPanel() {
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title="色とテーマ" variant="plain" hideTitle>
        <div id={searchableSetting("theme").id}>
          <ThemeLibrary
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setAppearanceMode={setAppearanceMode}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="appearance-interface" title="画面">
        <SettingsRow
          {...searchableSetting("setting-appearance-contrast")}
          description="画面全体の色と枠線のコントラストを調整します。"
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label="contrast"
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast"
              >
                {ja(settings.appearanceContrast)}%
              </output>
              <input
                aria-label="コントラスト"
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast });
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("setting-glass-opacity")}
          description="値を上げると、メニュー・ダイアログ・入力欄の背景が濃くなります。"
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="背景の不透明度"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {ja(settings.glassOpacity)}%
              </output>
              <input
                aria-label="背景の不透明度"
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        {showEnvironmentIdentification ? (
          <SettingsRow
            {...searchableSetting("environment-identification")}
            description="開発環境と開発版を見分ける表示方法を選びます。"
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label="環境の識別表示"
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  if (value === "artwork" || value === "pill" || value === "none") {
                    updateSettings({ environmentIdentificationMode: value });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="環境の識別表示">
                  <SelectValue>
                    {ja(ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {ja(
                    Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                      <SelectItem hideIndicator key={value} value={value}>
                        {ja(label)}
                      </SelectItem>
                    )),
                  )}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        <SettingsRow
          {...searchableSetting("diff-color-scheme")}
          description="追加・削除の色を選びます。変更件数にも適用されます。"
          resetAction={
            settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? (
              <SettingResetButton
                label="差分の色"
                onClick={() =>
                  updateSettings({ diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.diffColorScheme}
                onValueChange={(value) => {
                  if (value === "red-green" || value === "blue-orange")
                    updateSettings({ diffColorScheme: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="差分の色">
                  <span
                    aria-hidden="true"
                    className={
                      settings.diffColorScheme === "blue-orange"
                        ? "flex shrink-0 flex-row-reverse gap-1"
                        : "flex shrink-0 gap-1"
                    }
                  >
                    <span className="size-2 rounded-full bg-diff-deletion" />
                    <span className="size-2 rounded-full bg-diff-addition" />
                  </span>
                  <SelectValue>
                    {settings.diffColorScheme === "blue-orange" ? "青とオレンジ" : "赤と緑"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="red-green">赤と緑（既定）</SelectItem>
                  <SelectItem value="blue-orange">青とオレンジ</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("chat-width")}
          description="大きな画面でのメッセージと入力欄の最大幅を設定します。"
          resetAction={
            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
              <SettingResetButton
                label="チャットの幅"
                onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.chatWidth}
                onValueChange={(value) => {
                  if (value === "comfortable" || value === "wide" || value === "full")
                    updateSettings({ chatWidth: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="チャットの幅">
                  <SelectValue>{ja(CHAT_WIDTH_LABELS[settings.chatWidth])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="comfortable">標準の幅（既定）</SelectItem>
                  <SelectItem value="wide">広い幅</SelectItem>
                  <SelectItem value="full">全幅</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection id="motion" title="アニメーション">
        <SettingsRow
          {...searchableSetting("panel-animations")}
          description="パネルを開閉する速さを設定します。"
          control={
            <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
              <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
              <div className="flex w-full items-center gap-3">
                <output
                  className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="panel-animation-duration"
                >
                  {ja(settings.panelAnimationDurationMs)} ms
                </output>
                <input
                  aria-label="パネルのアニメーション時間"
                  className="settings-slider min-w-0 flex-1"
                  id="panel-animation-duration"
                  max={MAX_PANEL_ANIMATION_DURATION_MS}
                  min={MIN_PANEL_ANIMATION_DURATION_MS}
                  onChange={(event) => {
                    const panelAnimationDurationMs = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(panelAnimationDurationMs) &&
                      panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                      panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                    ) {
                      updateSettings({ panelAnimationDurationMs });
                    }
                  }}
                  step={25}
                  style={panelAnimationDurationSliderStyle}
                  type="range"
                  value={settings.panelAnimationDurationMs}
                />
              </div>
            </div>
          }
          resetAction={
            settings.panelAnimationDurationMs !==
            DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
              <SettingResetButton
                label="パネルのアニメーション"
                onClick={() =>
                  updateSettings({
                    panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                  })
                }
              />
            ) : null
          }
        />
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  );
}

function useFontDefaultFamilies() {
  const settings = useScopedSettings();
  // An unset preference shows the font it resolves to on this machine; the
  // default stacks are the platform's own faces, so the name is probed, not
  // hardcoded.
  const defaults = useMemo(
    () => ({
      sans: resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ?? "System default",
      code: resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ?? "System monospace",
    }),
    [],
  );
  return {
    sans: defaults.sans,
    code: defaults.code,
    // The composer inherits whatever the interface preference resolves to.
    interfaceFamily: settings.fontFamilySans.trim() || defaults.sans,
  };
}

function InterfaceFontRow({ preview }: { preview?: ReactNode }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("interface-font")}
      description="コードブロックとターミナル以外の文字に適用します。"
      defaultFamily={defaults.sans}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilySans}
      value={settings.fontFamilySans}
      onValueChange={(fontFamilySans) => updateSettings({ fontFamilySans })}
      onReset={() =>
        updateSettings({
          fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
          fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        })
      }
      size={{
        label: "Interface font size",
        min: MIN_INTERFACE_FONT_SIZE,
        max: MAX_INTERFACE_FONT_SIZE,
        value: settings.fontSizeInterface,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        onChange: (fontSizeInterface) => updateSettings({ fontSizeInterface }),
      }}
      {...(preview !== undefined ? { preview } : {})}
    />
  );
}

function PromptFontRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("prompt-font")}
      description="指示を入力する欄だけに適用します。等幅フォントも適しています。"
      defaultFamily={defaults.interfaceFamily}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer}
      value={settings.fontFamilyComposer}
      onValueChange={(fontFamilyComposer) => updateSettings({ fontFamilyComposer })}
      onReset={() =>
        updateSettings({
          fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
          fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        })
      }
      size={{
        label: "Prompt font size",
        min: MIN_PROMPT_FONT_SIZE,
        max: MAX_PROMPT_FONT_SIZE,
        value: settings.fontSizePrompt,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        onChange: (fontSizePrompt) => updateSettings({ fontSizePrompt }),
      }}
      preview={<PromptFontPreview />}
    />
  );
}

function CodeFontRow({
  title,
  description = "Code blocks, diffs, and file previews.",
  preview,
}: {
  title?: string;
  description?: string;
  preview?: ReactNode;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("code-font")}
      {...(title !== undefined ? { title } : {})}
      description={ja(description)}
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyCode}
      value={settings.fontFamilyCode}
      onValueChange={(fontFamilyCode) => updateSettings({ fontFamilyCode })}
      onReset={() =>
        updateSettings({
          fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
          fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        })
      }
      requireMonospace
      size={{
        label: "Code font size",
        min: MIN_CODE_FONT_SIZE,
        max: MAX_CODE_FONT_SIZE,
        value: settings.fontSizeCode,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        onChange: (fontSizeCode) => updateSettings({ fontSizeCode }),
      }}
      preview={preview ?? <CodeFontPreview />}
    />
  );
}

function TerminalFontRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("terminal-font")}
      description="ターミナルの文字に適用します。コードブロックや差分とは別の設定です。"
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal}
      value={settings.fontFamilyTerminal}
      onValueChange={(fontFamilyTerminal) => updateSettings({ fontFamilyTerminal })}
      onReset={() =>
        updateSettings({
          fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
          fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        })
      }
      requireMonospace
      size={{
        label: "Terminal font size",
        min: MIN_TERMINAL_FONT_SIZE,
        max: MAX_TERMINAL_FONT_SIZE,
        value: settings.fontSizeTerminal,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        onChange: (fontSizeTerminal) => updateSettings({ fontSizeTerminal }),
      }}
      preview={
        <TerminalFontPreview
          family={resolveTerminalFontPreference({
            advanced: true,
            code: settings.fontFamilyCode,
            terminal: settings.fontFamilyTerminal,
          })}
          size={settings.fontSizeTerminal}
        />
      }
    />
  );
}

function FontSmoothingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!isMacPlatform(navigator.platform)) return null;
  return (
    <SettingsRow
      {...searchableSetting("font-smoothing")}
      description="macOSの既定の描画より細い、グレースケールの文字描画を使います。"
      resetAction={
        settings.fontSmoothing !== DEFAULT_UNIFIED_SETTINGS.fontSmoothing ? (
          <SettingResetButton
            label="文字の滑らかさ"
            onClick={() =>
              updateSettings({ fontSmoothing: DEFAULT_UNIFIED_SETTINGS.fontSmoothing })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.fontSmoothing}
          onCheckedChange={(checked) => updateSettings({ fontSmoothing: Boolean(checked) })}
          aria-label="文字の滑らかさ"
        />
      }
    />
  );
}

function WordWrapRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("word-wrap")}
      description="コードブロック・表・差分・ファイルプレビューの長い行を折り返します。"
      resetAction={
        settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
          <SettingResetButton
            label="行の折り返し"
            onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wordWrap}
          onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
          aria-label="コード・表・差分・プレビューを既定で折り返す"
        />
      }
    />
  );
}

function FontSettingsGroup() {
  return (
    <>
      <InterfaceFontRow />
      <PromptFontRow />
      <CodeFontRow />
      <TerminalFontRow />
      <FontSmoothingRow />
    </>
  );
}

/**
 * The two-font view: one sans, one monospace. The prompt follows the
 * interface font and the terminal follows the monospace font, so the demos
 * under each row show every surface the choice reaches.
 */
function SimpleFontRows() {
  const settings = useScopedSettings();
  return (
    <>
      <InterfaceFontRow preview={<PromptFontPreview />} />
      <CodeFontRow
        title="等幅フォント"
        description="コードブロック・差分・ファイルプレビュー・ターミナルに適用します。"
        preview={
          <>
            <CodeFontPreview />
            <TerminalFontPreview
              family={resolveTerminalFontPreference({
                advanced: false,
                code: settings.fontFamilyCode,
                terminal: settings.fontFamilyTerminal,
              })}
              size={resolveTerminalFontSizePreference({
                advanced: false,
                code: settings.fontSizeCode,
                terminal: settings.fontSizeTerminal,
              })}
            />
          </>
        }
      />
    </>
  );
}

// Font smoothing only renders on macOS, so a search jump to it elsewhere
// must not flip the section - the target would never mount to be scrolled to.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
  ...(typeof navigator !== "undefined" && isMacPlatform(navigator.platform)
    ? ["font-smoothing"]
    : []),
]);

/**
 * The two-font view by default - one sans, one monospace, each cascading to
 * every surface it reaches - with an Advanced switch in the section header
 * that reveals the per-surface override rows. The choice persists locally,
 * and a settings-search jump to an override row flips Advanced on so the
 * target exists to scroll to.
 */
function TypographySection() {
  const [advanced, setAdvanced] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const searchTargetId = useSettingsSearchTargetId();
  // Flip Advanced on once per search jump so the hidden target can mount and
  // scroll; tracking the handled id lets the user turn it back off without
  // the still-set target immediately re-expanding the section.
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null || !ADVANCED_TYPOGRAPHY_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setAdvanced(true);
  }, [searchTargetId, setAdvanced]);
  return (
    <SettingsSection
      id="typography"
      title="文字の表示"
      headerAction={
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
          詳細設定
          <Switch
            checked={advanced}
            onCheckedChange={(checked) => setAdvanced(Boolean(checked))}
            aria-label="文字の詳細設定を表示"
          />
        </label>
      }
    >
      {advanced ? <FontSettingsGroup /> : <SimpleFontRows />}
      <WordWrapRow />
    </SettingsSection>
  );
}

function FontFamilySettingsRow({
  id,
  title,
  description,
  defaultFamily,
  defaultValue,
  preview,
  value,
  onValueChange,
  onReset,
  requireMonospace = false,
  size,
}: {
  id?: string;
  title: string;
  description: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  /** The persisted family value supplied by the unified settings defaults. */
  defaultValue: string;
  preview?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  onReset: () => void;
  requireMonospace?: boolean;
  size: {
    label: string;
    min: number;
    max: number;
    value: number;
    defaultValue: number;
    onChange: (v: number) => void;
  };
}) {
  const trimmed = value.trim();
  // The fallback input edits a draft; the preference only commits once typing
  // pauses and the text probes as an available font (or is an explicit
  // clear), so the current font holds and nothing reflows mid-word.
  const [draft, setDraft] = useState(value);
  const [draftSettled, setDraftSettled] = useState(true);
  const commitTimerRef = useRef<number | null>(null);
  const lastValueRef = useRef(value);
  if (lastValueRef.current !== value) {
    // The committed value changed externally (hydration, reset, picker
    // selection); adopt it and drop any pending commit of a stale draft.
    lastValueRef.current = value;
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    setDraft(value);
    setDraftSettled(true);
  }
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    },
    [],
  );
  const acceptsFamily = (candidate: string) =>
    isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamily(candidate));
  const commitDraft = (next: string) => {
    setDraftSettled(true);
    // A rejected name stays in the field, flagged: the terminal would silently
    // fall back to its default, so the row must not claim it took the value.
    if (next.trim().length === 0 || acceptsFamily(next)) {
      onValueChange(next);
    }
  };
  const flushDraft = () => {
    if (commitTimerRef.current === null) return;
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    commitDraft(draft);
  };
  const draftTrimmed = draft.trim();
  // Flag an unknown name only once typing pauses, and never for an empty
  // field - that is the starting state, not a rejected entry.
  const draftPending = draftSettled && draftTrimmed.length > 0 && draftTrimmed !== trimmed;
  const resetToDefault = () => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    setDraft(defaultValue);
    setDraftSettled(true);
    onReset();
  };
  const resetAction =
    value !== defaultValue || size.value !== size.defaultValue ? (
      <SettingResetButton label={ja(title.toLowerCase())} onClick={resetToDefault} />
    ) : null;
  const fontEnumeration = useFontEnumeration();
  // Everyone starts on the plain input; focusing it is the user gesture that
  // runs font discovery. Where the engine can enumerate, the control then
  // upgrades to the picker - popped open when the swap happens under focus,
  // so the interaction continues without a second click.
  const inputFocusedRef = useRef(false);
  const familyControl =
    fontEnumeration.status === "granted" ? (
      <FontFamilyPicker
        ariaLabel={jaTemplate`${title} family`}
        defaultFamily={defaultFamily}
        selectedFamily={trimmed}
        requireMonospace={requireMonospace}
        initialOpen={inputFocusedRef.current}
        onSelect={onValueChange}
      />
    ) : (
      <Input
        size="sm"
        aria-label={jaTemplate`${title} family`}
        aria-invalid={draftPending || undefined}
        autoCapitalize="off"
        autoComplete="off"
        className="min-w-0 flex-1"
        maxLength={200}
        onFocus={() => {
          inputFocusedRef.current = true;
          discoverInstalledFonts();
        }}
        onBlur={() => {
          inputFocusedRef.current = false;
          flushDraft();
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          setDraftSettled(false);
          if (commitTimerRef.current !== null) {
            window.clearTimeout(commitTimerRef.current);
          }
          commitTimerRef.current = window.setTimeout(() => {
            commitTimerRef.current = null;
            commitDraft(next);
          }, 400);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") flushDraft();
          if (event.key === "Escape") {
            // Discard uncommitted typing without closing the settings page,
            // which is what an unhandled Escape does.
            event.preventDefault();
            event.stopPropagation();
            if (commitTimerRef.current !== null) {
              window.clearTimeout(commitTimerRef.current);
              commitTimerRef.current = null;
            }
            setDraft(value);
            setDraftSettled(true);
          }
        }}
        placeholder={ja(defaultFamily)}
        spellCheck={false}
        value={draft}
      />
    );
  const control = (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">{ja(familyControl)}</div>
      <Select
        value={String(size.value)}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          const parsed = Number(next);
          if (Number.isInteger(parsed) && parsed >= size.min && parsed <= size.max) {
            size.onChange(parsed);
          }
        }}
      >
        <SelectTrigger size="sm" className="w-22 shrink-0" aria-label={ja(size.label)}>
          <SelectValue>{ja(size.value)} px</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {ja(
            Array.from({ length: size.max - size.min + 1 }, (_, index) => size.min + index).map(
              (px) => (
                <SelectItem hideIndicator key={px} value={String(px)}>
                  {ja(px)} px
                </SelectItem>
              ),
            ),
          )}
        </SelectPopup>
      </Select>
    </div>
  );
  return (
    <SettingsRow
      {...(id !== undefined ? { id } : {})}
      title={ja(title)}
      description={ja(description)}
      resetAction={resetAction}
      control={control}
    >
      {ja(preview)}
    </SettingsRow>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="自動で完了扱いにするまでの日数"
    />
  );
}

// The legacy rows sit behind the fold, so a settings-search jump has to
// expand the section before its target can mount and scroll.
const LEGACY_FEATURE_TARGET_IDS: ReadonlySet<string> = new Set([
  "legacy-plan-mode",
  "legacy-context-window-indicator",
  "legacy-sidebar",
]);

/**
 * Retired features kept only for users who still depend on them. Collapsed by
 * default so they stay out of the everyday settings path; a settings-search
 * jump to one of the rows unfolds the section.
 */
function LegacyFeaturesSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLElement>("legacy-features");
  // Unfold once per search jump; tracking the handled id lets the user fold
  // the section back up without the still-set target immediately reopening it.
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      // A handled jump clears the target; forgetting it here lets a later
      // jump to the same row expand the section again.
      lastExpandedTargetRef.current = null;
      return;
    }
    if (!LEGACY_FEATURE_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setOpen(true);
  }, [searchTargetId]);

  return (
    <section id="legacy-features" ref={targetRef} tabIndex={-1} className="space-y-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 sm:px-4">
          <h2 className="text-sm font-normal text-foreground/70 transition-colors group-hover:text-foreground">
            旧機能
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <SettingsGroup>
            <SettingsRow
              {...searchableSetting("legacy-plan-mode")}
              description="実装／計画の切り替え、/plan、/default、Shift+Tabを復元します。オフの場合は実装モードを使います。"
              control={
                <Switch
                  checked={settings.planModeEnabled}
                  onCheckedChange={(checked) => {
                    updateSettings({ planModeEnabled: Boolean(checked) });
                  }}
                  aria-label="計画モード（旧機能）"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-context-window-indicator")}
              description="入力欄に丸いコンテキスト使用量の表示を追加します。"
              control={
                <Switch
                  checked={settings.contextWindowMeterEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ contextWindowMeterEnabled: Boolean(checked) })
                  }
                  aria-label="コンテキスト使用量の表示（旧機能）"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-sidebar")}
              description="フォルダーの下に会話を並べます。長い一覧は「もっと表示する」で広げられます。"
              control={
                <Switch
                  checked={settings.legacySidebarEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ legacySidebarEnabled: Boolean(checked) })
                  }
                  aria-label="フォルダー型サイドバー"
                />
              }
            />
          </SettingsGroup>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

export function GeneralSettingsPanel() {
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const sendShortcutOptions = [
    { value: "enter", label: "Enter" },
    { value: "mod-enter-multiline", label: `${modifierLabel} + Enter for multiline prompts` },
    { value: "mod-enter", label: `${modifierLabel} + Enter always` },
  ] as const;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  // The representative environment supplies the provider list for pickers;
  // a fanned-out model choice is validated against every target before it
  // is written. Per-machine tuning (background activity overrides) still
  // needs exactly one environment.
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const [tokenStreamingWarningOpen, setTokenStreamingWarningOpen] = useState(false);
  const mixedResponseStreamingMode = useScopedSettingsMixed(["responseStreamingMode"]);
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const supportsAutoSettlement =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    );
  const supportsRestartContinuation =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadRestartContinuation === true,
    );

  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(
    settings,
    textGenerationProviders,
  );
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(textGenerationProviders), settings),
  );
  const hasTextGenerationProvider = textGenerationModelInstanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const textGenerationModelDisabledReason = useScopedModelDisabledReason(
    settings,
    textGenerationModelInstanceEntries,
  );
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const mixedBackgroundActivity = useScopedSettingsMixed(["backgroundActivity"]);
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);
  const mixedTextGenerationModel = useScopedSettingsMixed(["textGenerationModelSelection"]);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} Shared policy: ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile];
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="general" />
      <SettingsSection id="organization" title="整理">
        <SettingsRow
          {...searchableSetting("project-grouping")}
          description="環境をまたぐ同じリポジトリをまとめて表示します。"
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="プロジェクトのグループ化"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label="プロジェクトのグループ化"
            />
          }
        />

        {supportsAutoSettlement ? (
          <>
            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleOnMerge"]}
              {...searchableSetting("auto-settle-merged-threads")}
              description="プルリクエストをマージしたらチャットを完了扱いにします。閉じたプルリクエストも自動で完了扱いになります。"
              resetAction={
                settings.sidebarAutoSettleOnMerge !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
                  <SettingResetButton
                    label="マージ後に自動で完了扱いにする"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleOnMerge"]}
                  checked={settings.sidebarAutoSettleOnMerge}
                  onCheckedChange={(checked) =>
                    updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
                  }
                  aria-label="マージ済みチャットを自動で完了扱いにする"
                />
              }
            />

            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleAfterDays"]}
              {...searchableSetting("auto-settle-inactive-threads")}
              description="指定した期間、操作のないチャットを自動で完了扱いにします。"
              resetAction={
                settings.sidebarAutoSettleAfterDays !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
                  <SettingResetButton
                    label="auto-settle"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleAfterDays:
                          DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleAfterDays"]}
                  checked={settings.sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="使っていないチャットを自動で完了扱いにする"
                />
              }
            />
            {settings.sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                serverScoped
                settingKeys={["sidebarAutoSettleAfterDays"]}
                title={ja(searchableSetting("days-before-auto-settle").title)}
                description="新しい操作があれば、自動でチャットを再開します。"
                control={
                  <AutoSettleDaysInput
                    value={settings.sidebarAutoSettleAfterDays}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection id="behavior" title="動作">
        <NotificationSettings />
        <SettingsRow
          {...searchableSetting("in-app-notifications")}
          description="アプリを操作中に、別のチャットの完了・失敗・入力や承認の要求を表示します。"
          control={
            <Switch
              checked={settings.inAppNotificationsEnabled}
              onCheckedChange={(checked) => updateSettings({ inAppNotificationsEnabled: checked })}
              aria-label="アプリ内通知"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("time-format")}
          description="システムの既定を選ぶと、ブラウザやOSの時刻設定に従います。"
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="時刻の表示"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="時刻の形式">
                <SelectValue>{ja(TIMESTAMP_FORMAT_LABELS[settings.timestampFormat])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {ja(TIMESTAMP_FORMAT_LABELS.locale)}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {ja(TIMESTAMP_FORMAT_LABELS["12-hour"])}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {ja(TIMESTAMP_FORMAT_LABELS["24-hour"])}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["responseStreamingMode"]}
          {...searchableSetting("response-streaming")}
          description={
            mixedResponseStreamingMode
              ? "選んだ対象で回答の表示方法が異なります。"
              : RESPONSE_STREAMING_MODE_DESCRIPTIONS[settings.responseStreamingMode]
          }
          resetAction={
            settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode ? (
              <SettingResetButton
                label="回答の表示方法"
                onClick={() =>
                  updateSettings({
                    responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <>
              <Select
                value={mixedResponseStreamingMode ? null : settings.responseStreamingMode}
                onValueChange={(value) => {
                  if (value === "token") {
                    // The legacy path needs an explicit confirmation.
                    setTokenStreamingWarningOpen(true);
                    return;
                  }
                  if (value === "turn" || value === "paragraph") {
                    updateSettings({ responseStreamingMode: value });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="回答の表示方法">
                  <SelectValue>
                    {ja((value: ResponseStreamingMode | null) =>
                      value === null ? "Mixed" : RESPONSE_STREAMING_MODE_LABELS[value],
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="turn">
                    {ja(RESPONSE_STREAMING_MODE_LABELS.turn)}
                  </SelectItem>
                  <SelectItem hideIndicator value="paragraph">
                    {ja(RESPONSE_STREAMING_MODE_LABELS.paragraph)}
                  </SelectItem>
                  <SelectItem hideIndicator value="token">
                    {ja(RESPONSE_STREAMING_MODE_LABELS.token)}
                  </SelectItem>
                </SelectPopup>
              </Select>
              <TokenStreamingWarningDialog
                open={tokenStreamingWarningOpen}
                onOpenChange={setTokenStreamingWarningOpen}
                onConfirm={() => {
                  updateSettings({ responseStreamingMode: "token" });
                  setTokenStreamingWarningOpen(false);
                }}
                onUseParagraphs={() => {
                  updateSettings({ responseStreamingMode: "paragraph" });
                  setTokenStreamingWarningOpen(false);
                }}
              />
            </>
          }
        />
        <SettingsRow
          {...searchableSetting("hide-whitespace-changes")}
          description="差分画面で、空白だけの変更を無視するか設定します。"
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="空白の差分表示"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="空白の変更を既定で非表示"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("default-diff-file-state")}
          description="差分やプルリクエストのコード画面で、最初にファイルを展開するか折りたたむか設定します。"
          resetAction={
            settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed ? (
              <SettingResetButton
                label="差分ファイルの初期表示"
                onClick={() =>
                  updateSettings({
                    diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffFilesCollapsed ? "collapsed" : "expanded"}
              onValueChange={(value) => {
                if (value === "expanded" || value === "collapsed") {
                  updateSettings({ diffFilesCollapsed: value === "collapsed" });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="差分ファイルの初期表示"
              >
                <SelectValue>{settings.diffFilesCollapsed ? "折りたたむ" : "展開"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="expanded">
                  展開
                </SelectItem>
                <SelectItem hideIndicator value="collapsed">
                  折りたたむ
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("diff-layout")}
          description="差分を上下または左右に並べて表示します。差分画面のツールバーでも変更できます。"
          resetAction={
            settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? (
              <SettingResetButton
                label="差分の表示方法"
                onClick={() => updateSettings({ diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffLayout}
              onValueChange={(value) => {
                if (value === "stacked" || value === "split") {
                  updateSettings({ diffLayout: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="差分の表示方法">
                <SelectValue>{ja(DIFF_LAYOUT_LABELS[settings.diffLayout])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="stacked">
                  {ja(DIFF_LAYOUT_LABELS.stacked)}
                </SelectItem>
                <SelectItem hideIndicator value="split">
                  {ja(DIFF_LAYOUT_LABELS.split)}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("proactive-panels")}
          description="関連するプルリクエストを優先して開きます。なければ3ファイル以上または50行以上の変更で差分を開きます。"
          resetAction={
            settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled ? (
              <SettingResetButton
                label="関連パネルの自動表示"
                onClick={() =>
                  updateSettings({
                    proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.proactivePanelsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ proactivePanelsEnabled: Boolean(checked) })
              }
              aria-label="関連パネルを自動で開く"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("skills-in-slash-menu")}
          description="/コマンドメニューにもスキルを表示します。$を入力したときは常に表示されます。"
          resetAction={
            settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
              <SettingResetButton
                label="スラッシュメニューのスキル"
                onClick={() =>
                  updateSettings({
                    showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.showSkillsInSlashMenu}
              onCheckedChange={(checked) =>
                updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
              }
              aria-label="スラッシュメニューにスキルを表示"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("composer-rich-text")}
          description="入力中にMarkdownの書式を表示します。"
          resetAction={
            settings.composerRichTextEnabled !==
            DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
              <SettingResetButton
                label="入力欄のMarkdown表示"
                onClick={() =>
                  updateSettings({
                    composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerRichTextEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ composerRichTextEnabled: Boolean(checked) })
              }
              aria-label="入力欄のMarkdown表示"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("composer-collapse")}
          description="会話をスクロールすると入力欄を1行に縮めます。入力欄を選ぶか入力すると元に戻ります。"
          resetAction={
            settings.composerCollapseOnScroll !==
            DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll ? (
              <SettingResetButton
                label="スクロール時の入力欄縮小"
                onClick={() =>
                  updateSettings({
                    composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerCollapseOnScroll}
              onCheckedChange={(checked) =>
                updateSettings({ composerCollapseOnScroll: Boolean(checked) })
              }
              aria-label="スクロール時に入力欄を縮小"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("attach-by-reference")}
          description="Mac版アプリで、動画・音声と指定サイズ以上のファイルをコピーせず元の場所のパスで添付します。元のファイルを移動・削除すると読めなくなります。画像と他のPC上の環境では今までどおりアップロードします。"
          resetAction={
            settings.attachByReference !== DEFAULT_UNIFIED_SETTINGS.attachByReference ? (
              <SettingResetButton
                label="ファイルの参照添付"
                onClick={() =>
                  updateSettings({ attachByReference: DEFAULT_UNIFIED_SETTINGS.attachByReference })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.attachByReference}
              onValueChange={(value) => {
                const option = ATTACH_BY_REFERENCE_OPTIONS.find((option) => option.value === value);
                if (option) updateSettings({ attachByReference: option.value });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0 max-w-full"
                aria-label="ファイルの参照添付"
              >
                <SelectValue>
                  {
                    ATTACH_BY_REFERENCE_OPTIONS.find(
                      (option) => option.value === settings.attachByReference,
                    )?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {ATTACH_BY_REFERENCE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center justify-between gap-4">
                      {option.label}
                      {settings.attachByReference === option.value && (
                        <CheckIcon aria-hidden="true" />
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("send-shortcut")}
          description="Enterキーで送信するか、改行するか選びます。"
          resetAction={
            settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
              <SettingResetButton
                label="送信キー"
                onClick={() =>
                  updateSettings({ sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sendShortcut}
              onValueChange={(value) => {
                const option = sendShortcutOptions.find((option) => option.value === value);
                if (option) updateSettings({ sendShortcut: option.value });
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-0 max-w-full" aria-label="送信キー">
                <SelectValue>
                  {ja(
                    sendShortcutOptions.find((option) => option.value === settings.sendShortcut)
                      ?.label,
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {ja(
                  sendShortcutOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex items-center justify-between gap-4">
                        {ja(option.label)}
                        {ja(
                          settings.sendShortcut === option.value && (
                            <CheckIcon aria-hidden="true" />
                          ),
                        )}
                      </span>
                    </SelectItem>
                  )),
                )}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("follow-up-behavior")}
          description={ja(
            "Queue follow-ups while the agent runs or steer the current run. " +
              (settings.sendShortcut === "mod-enter-multiline"
                ? `Press ${modifierLabel} + Enter for single-line prompts or ${modifierLabel} + Shift + Enter for multiline prompts to do the opposite for one message.`
                : `Press ${modifierLabel}${settings.sendShortcut === "mod-enter" ? " + Shift" : ""} + Enter to do the opposite for one message.`),
          )}
          resetAction={
            settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
              <SettingResetButton
                label="追加指示の扱い"
                onClick={() =>
                  updateSettings({
                    followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.followUpBehavior}
              onValueChange={(value) => {
                if (value === "queue" || value === "steer") {
                  updateSettings({ followUpBehavior: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0"
                aria-label="実行中に送った指示の扱い"
              >
                <SelectValue>
                  {settings.followUpBehavior === "queue" ? "順番待ち" : "実行中の作業に反映"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="queue">順番待ち</SelectItem>
                <SelectItem value="steer">実行中の作業に反映</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={["enableProviderUpdateChecks"]}
          {...searchableSetting("provider-update-checks")}
          description="インストール済みのエージェントCLIの更新を確認します。"
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="エージェントの更新確認"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["enableProviderUpdateChecks"]}
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="エージェントのバージョンを確認"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continue-threads-after-server-update")}
          serverScoped
          settingKeys={["continueThreadsAfterServerUpdate"]}
          description="更新・クラッシュ・パソコンの再起動後に中断したチャットを自動で再開します。古いサーバーは先に更新してください。"
          status={
            !supportsRestartContinuation
              ? ja("All selected connected environments must support restart continuation.")
              : undefined
          }
          resetAction={
            supportsRestartContinuation &&
            settings.continueThreadsAfterServerUpdate !==
              DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
              <SettingResetButton
                label="再起動後にチャットを続行"
                onClick={() =>
                  updateSettings({
                    continueThreadsAfterServerUpdate:
                      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["continueThreadsAfterServerUpdate"]}
              checked={settings.continueThreadsAfterServerUpdate}
              disabled={!supportsRestartContinuation}
              onCheckedChange={(checked) =>
                updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
              }
              aria-label="再起動後にチャットを続行"
            />
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={["backgroundActivity"]}
          id={searchableSetting("background-activity").id}
          title={
            <span className="inline-flex items-center gap-1.5">
              {ja(searchableSetting("background-activity").title)}
              <PolicyTooltip>
                Gitの更新やエージェント確認の間隔が経過した後、実行するかどうかを共通の条件で決めます。
              </PolicyTooltip>
            </span>
          }
          description={ja(backgroundActivityDescription)}
          resetAction={
            canResetBackgroundActivity ? (
              <SettingResetButton
                label="バックグラウンド動作"
                onClick={() => updateSettings(resetBackgroundActivitySettings())}
              />
            ) : null
          }
          control={
            <>
              <Select
                value={mixedBackgroundActivity ? null : backgroundActivityProfileOption}
                onValueChange={(value) => {
                  if (value === "advanced") {
                    if (isEnvironmentScope) setBackgroundActivityDialogOpen(true);
                    return;
                  }
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings(backgroundActivityProfileSettings(value));
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="バックグラウンド動作の設定"
                >
                  <SelectValue>
                    {ja((value: BackgroundActivityProfileOption | null) =>
                      value === null ? "Mixed" : BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[value],
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {ja(BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced)}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {ja(BACKGROUND_ACTIVITY_PROFILE_LABELS.performance)}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {ja(BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"])}
                  </SelectItem>
                  <SelectItem hideIndicator value="advanced" disabled={!isEnvironmentScope}>
                    {isEnvironmentScope
                      ? BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced
                      : `${BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced} (one environment)`}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {backgroundActivityProfileOption === "advanced" && isEnvironmentScope ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="バックグラウンド動作の詳細設定"
                        onClick={() => setBackgroundActivityDialogOpen(true)}
                      >
                        <SettingsIcon className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">バックグラウンド動作を設定</TooltipPopup>
                </Tooltip>
              ) : null}
              <BackgroundActivityAdvancedDialog
                open={backgroundActivityDialogOpen && isEnvironmentScope}
                onOpenChange={setBackgroundActivityDialogOpen}
              />
            </>
          }
        />
      </SettingsSection>

      <SettingsSection id="projects-and-threads" title="プロジェクトとチャット">
        <SettingsRow
          serverScoped
          settingKeys={["newWorktreesStartFromOrigin"]}
          {...searchableSetting("start-from-origin")}
          description="ローカルのブランチではなく、originの最新ブランチからワークツリーを作ります。"
          resetAction={
            settings.newWorktreesStartFromOrigin !==
            DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
              <SettingResetButton
                label="新しいワークツリーをoriginから開始"
                onClick={() =>
                  updateSettings({
                    newWorktreesStartFromOrigin:
                      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["newWorktreesStartFromOrigin"]}
              checked={settings.newWorktreesStartFromOrigin}
              onCheckedChange={(checked) =>
                updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
              }
              aria-label="新しいワークツリーを既定でoriginから開始"
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["addProjectBaseDirectory"]}
          {...searchableSetting("add-project-starts-in")}
          description="空欄の場合、プロジェクト追加時にホームフォルダを開きます。"
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="プロジェクト追加の開始フォルダ"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={mixedAddProjectBaseDirectory ? "" : settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder={mixedAddProjectBaseDirectory ? "複数の値" : "~/"}
              spellCheck={false}
              aria-label="プロジェクト追加の開始フォルダ"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="confirmations" title="確認">
        <SettingsRow
          {...searchableSetting("unpin-confirmation")}
          description="固定したチャットを解除する前に確認します。"
          resetAction={
            settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
              <SettingResetButton
                label="固定解除の確認"
                onClick={() =>
                  updateSettings({
                    confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label="チャットの固定解除を確認"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("archive-confirmation")}
          description="アーカイブ操作をもう一度押して確定します。"
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="アーカイブの確認"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="チャットのアーカイブを確認"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("delete-confirmation")}
          description="チャットと会話履歴を削除する前に確認します。"
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="削除の確認"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="チャットの削除を確認"
            />
          }
        />

        {isElectron ? (
          <SettingsRow
            {...searchableSetting("quit-confirmation")}
            description="長押しモードでは、素早く2回押しても終了できます。"
            resetAction={
              settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? (
                <SettingResetButton
                  label="終了キーの動作"
                  onClick={() =>
                    updateSettings({ confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.confirmQuit}
                onValueChange={(value) => {
                  if (value === "direct" || value === "hold" || value === "double-click") {
                    updateSettings({ confirmQuit: value });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="終了キーの動作">
                  <SelectValue>
                    {ja(QUIT_CONFIRMATION_MODE_LABELS[settings.confirmQuit])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {ja(
                    Object.entries(QUIT_CONFIRMATION_MODE_LABELS).map(([value, label]) => (
                      <SelectItem hideIndicator key={value} value={value}>
                        {ja(label)}
                      </SelectItem>
                    )),
                  )}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection id="text-generation" title="補助テキストの生成">
        <SettingsRow
          serverScoped
          settingKeys={["textGenerationModelSelection"]}
          {...searchableSetting("text-generation-model")}
          description="このエージェントを使うデバイスで、チャット名などの生成に使います。バージョン管理の設定で変更できます。"
          resetAction={
            hasServerTargets && isTextGenerationModelDirty ? (
              <SettingResetButton
                label="補助テキスト生成用モデル"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                補助テキスト生成用のモデルを選ぶには、環境に接続してください。
              </span>
            ) : !hasTextGenerationProvider ? (
              <span className="text-sm text-muted-foreground">
                補助テキストを生成できるエージェントはありません。
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={textGenInstanceId}
                  model={textGenModel}
                  lockedProvider={null}
                  instanceEntries={textGenerationModelInstanceEntries}
                  modelOptionsByInstance={textGenerationModelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  {...(mixedTextGenerationModel ? { triggerLabel: "Mixed" } : {})}
                  getModelDisabledReason={textGenerationModelDisabledReason}
                  {...(environmentId
                    ? {
                        onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                          void navigate({
                            to: "/settings/providers",
                            search: { environmentId, instanceId },
                          });
                        },
                      }
                    : {})}
                  onInstanceModelChange={(instanceId, model) => {
                    const reason = textGenerationModelDisabledReason(instanceId, model);
                    if (reason) {
                      toastManager.add({
                        type: "error",
                        title: "Text generation model not saved",
                        description: reason,
                      });
                      return;
                    }
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(instanceId, model),
                        },
                        textGenerationProviders,
                      ),
                    });
                  }}
                />
                {textGenInstanceEntry ? (
                  <TraitsPicker
                    provider={textGenProvider}
                    models={
                      // Use the exact instance's models (rather than the
                      // first-kind-match) so a custom text-gen instance like
                      // `codex_personal` gets its own model list, not the
                      // default Codex one.
                      textGenInstanceEntry?.models ?? []
                    }
                    model={textGenModel}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={textGenModelOptions}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(nextOptions) => {
                      updateSettings({
                        textGenerationModelSelection: resolveAppModelSelectionState(
                          {
                            ...settings,
                            textGenerationModelSelection: createModelSelection(
                              textGenInstanceId,
                              textGenModel,
                              nextOptions,
                            ),
                          },
                          textGenerationProviders,
                        ),
                      });
                    }}
                  />
                ) : null}
              </div>
            )
          }
        />
      </SettingsSection>

      <DelegationSettings />

      <SettingsSection id="about" title="このアプリについて">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow title={<AboutVersionTitle />} description="現在のアプリのバージョンです。" />
        )}
      </SettingsSection>
      <SettingsSection title="診断">
        <SettingsRow
          {...searchableSetting("diagnostics")}
          description={
            isEnvironmentScope
              ? "この環境のプロセス・リソース使用量・ログを確認します。"
              : "環境ごとにプロセス・リソース使用量・ログを確認します。"
          }
          control={
            <Button
              render={
                <Link to="/settings/diagnostics" search={{ machine: environmentId ?? undefined }} />
              }
              size="sm"
              variant="outline"
            >
              診断を開く
            </Button>
          }
        />
        <SettingsRow
          {...searchableSetting("open-source-licenses")}
          description="T3 Codeが使う依存ライブラリ・素材・追加ツールのライセンスです。"
          control={
            <Button
              render={<Link to="/settings/open-source-licenses" />}
              size="sm"
              variant="outline"
            >
              ライセンスを開く
            </Button>
          }
        />
      </SettingsSection>

      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const { scope } = useSettingsScope();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);

  const archivedGroups = useMemo(() => {
    const selectedProjectKeys =
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null;
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(`${environmentId}:${project.id}`),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots, scope]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        const result = await unarchiveThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        const result = await confirmAndDeleteThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={ja(searchableSetting("archive").title)}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "アーカイブしたチャットを読み込み中"
                  : archiveError
                    ? "アーカイブしたチャットを読み込めませんでした"
                    : "アーカイブしたチャットはありません"}
              </span>
            }
            description={
              isLoadingArchive
                ? "接続済みの環境を確認しています。"
                : (archiveError ?? ja("Archived threads will appear here."))
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }, index) => (
          <SettingsSection
            key={`${project.environmentId}:${project.id}`}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={project.title}
            icon={<ProjectFavicon project={project} />}
          >
            {ja(
              projectThreads.map((thread) => (
                <SettingsRow
                  key={thread.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void (async () => {
                      const result = await settlePromise(() =>
                        handleArchivedThreadContextMenu(
                          scopeThreadRef(thread.environmentId, thread.id),
                          {
                            x: event.clientX,
                            y: event.clientY,
                          },
                        ),
                      );
                      if (result._tag === "Failure") {
                        const error = squashAtomCommandFailure(result);
                        toastManager.add(
                          stackedThreadToast({
                            type: "error",
                            title: "Archived thread action failed",
                            description:
                              error instanceof Error ? error.message : "An error occurred.",
                          }),
                        );
                      }
                    })();
                  }}
                  title={thread.title}
                  description={
                    <>
                      アーカイブ済み{" "}
                      {ja(formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt))}
                      {ja(" \u00b7 Created ")}
                      {ja(formatRelativeTimeLabel(thread.createdAt))}
                    </>
                  }
                  control={
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="shrink-0"
                      onClick={() => {
                        void (async () => {
                          const result = await unarchiveThread(
                            scopeThreadRef(thread.environmentId, thread.id),
                          );
                          if (result._tag === "Success") {
                            refreshArchivedThreads();
                            return;
                          }
                          if (!isAtomCommandInterrupted(result)) {
                            const error = squashAtomCommandFailure(result);
                            toastManager.add(
                              stackedThreadToast({
                                type: "error",
                                title: "Failed to unarchive thread",
                                description:
                                  error instanceof Error ? error.message : "An error occurred.",
                              }),
                            );
                          }
                        })();
                      }}
                    >
                      <ArchiveX className="size-3.5" />
                      <span>アーカイブから戻す</span>
                    </Button>
                  }
                />
              )),
            )}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
