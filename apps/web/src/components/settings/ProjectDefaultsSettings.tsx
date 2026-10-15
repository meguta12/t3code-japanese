import { ja } from "../../lib/ja";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderInstanceId,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import type { ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Rows for the settings a project may override. The same rows edit
 * environment defaults at an environment scope and project overrides at a
 * project or checkout scope; the scoped hooks route the write.
 */
const WORKTREE_SUBMODULES_OPTIONS = ["recursive", "top-level", "none"] as const;
function isWorktreeSubmodules(value: string | null): value is WorktreeSubmodules {
  return value !== null && (WORKTREE_SUBMODULES_OPTIONS as readonly string[]).includes(value);
}

export function ProjectDefaultsSettings({ category }: { category: ProjectSettingsCategory }) {
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const selection = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const mixedModel = useScopedSettingsMixed(["defaultModelSelection"]);
  const mixedPermissions = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const PermissionIcon = runtimeModeConfig[settings.defaultRuntimeMode].icon;
  const mixedWorkspace = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const mixedSubmodules = useScopedSettingsMixed(["worktreeSubmodules"]);
  const mixedBrowser = useScopedSettingsMixed(["enableAgentBrowserAccess"]);
  const mixedAutoPull = useScopedSettingsMixed(["defaultAutoPull"]);
  const mixedMergeMethod = useScopedSettingsMixed(["pullRequestMergeMethod"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  // File-backed keys show their effective value; the target already carries
  // the checkout's t3.json, and a null file here only fills the built-in.
  // The reset arrow beside the title clears the tier (SettingsRow handles a
  // project override, the environment value is cleared here), so the picker
  // has no "inherit" item.
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;

  function modelDisabledReason(instanceId: ProviderInstanceId, model: string): string | null {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const config = environment?.serverConfig;
      if (!config) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(config.providers),
        candidate.settings,
      ).find((option) => option.instanceId === instanceId);
      const options = getCustomModelOptionsByInstance(
        { ...settings, ...candidate.settings },
        config.providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      }
    }
    return null;
  }

  const setModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Default model not saved", description: reason });
      return;
    }
    updateSettings({ defaultModelSelection: value });
  };

  const modelRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelSelection"]}
      mixed={mixedModel}
      id="default-model"
      title="モデル"
      description={
        isProjectScope
          ? "このプロジェクトの新しいチャットで使うモデルです。"
          : "新しいチャットで使うモデルです。プロジェクトごとに変更できます。"
      }
      status={
        unavailable || mixedModel || modelSource === "project"
          ? undefined
          : settings.defaultModelSelection === null
            ? ja("Automatic")
            : undefined
      }
      resetAction={
        settings.defaultModelSelection !== null ? (
          <SettingResetButton label="既定のモデル" onClick={() => setModel(null)} />
        ) : null
      }
      control={
        selection && activeEntry ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
              getModelDisabledReason={modelDisabledReason}
              onOpenProviderSetup={(instanceId) => {
                if (representative)
                  void navigate({
                    to: "/settings/providers",
                    search: { environmentId: representative.environmentId, instanceId },
                  });
              }}
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
            />
            {!mixedModel ? (
              <TraitsPicker
                provider={activeEntry.driverKind}
                models={activeEntry.models}
                model={selection.model}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={settings.planModeEnabled}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  setModel(createModelSelection(selection.instanceId, selection.model, options))
                }
              />
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">利用可能なエージェントはありません</span>
        )
      }
    />
  );
  const workspaceRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultThreadEnvMode"]}
      mixed={mixedWorkspace}
      id={searchableSetting("new-threads").id}
      title="作業場所"
      description={
        isProjectScope
          ? "このプロジェクトの新しいチャットの作業場所です。"
          : "新しいチャットの作業場所です。プロジェクトやt3.jsonで変更できます。"
      }
      resetAction={
        !isProjectScope && settings.defaultThreadEnvMode !== null ? (
          <SettingResetButton
            label="既定の作業場所"
            onClick={() => updateSettings({ defaultThreadEnvMode: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixedWorkspace ? null : (effective?.defaultThreadEnvMode ?? null)}
          onValueChange={(value) => {
            if (value === "local" || value === "worktree")
              updateSettings({ defaultThreadEnvMode: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="既定の作業場所">
            <SelectValue>
              {ja((value: string | null) =>
                value === "local" || value === "worktree"
                  ? resolveEnvModeLabel(value)
                  : unavailable
                    ? "Unavailable"
                    : "Mixed",
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="local">{ja(resolveEnvModeLabel("local"))}</SelectItem>
            <SelectItem value="worktree">{ja(resolveEnvModeLabel("worktree"))}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );

  return (
    <SettingsSection
      id={
        category === "general" || category === "project"
          ? "project-defaults"
          : category === "integrations"
            ? "browser-access"
            : "source-control-defaults"
      }
      title={
        category === "general" || category === "project"
          ? "新しいチャット"
          : category === "integrations"
            ? "ブラウザ"
            : "リポジトリ"
      }
    >
      {category === "project" ? (
        <>
          {ja(modelRow)}
          {ja(workspaceRow)}
        </>
      ) : category === "general" ? (
        <>
          {ja(modelRow)}
          <SettingsRow
            serverScoped
            settingKeys={["defaultRuntimeMode"]}
            mixed={mixedPermissions}
            {...searchableSetting("default-permissions")}
            description={
              isProjectScope
                ? "このプロジェクトの新しいチャットのアクセス権限です。"
                : "新しいチャットのアクセス権限です。プロジェクトごとに変更できます。"
            }
            resetAction={
              settings.defaultRuntimeMode !== DEFAULT_SERVER_SETTINGS.defaultRuntimeMode ? (
                <SettingResetButton
                  label="既定のアクセス権限"
                  onClick={() =>
                    updateSettings({
                      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedPermissions ? null : settings.defaultRuntimeMode}
                onValueChange={(value) => {
                  if (value) updateSettings({ defaultRuntimeMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="既定のアクセス権限">
                  {ja(
                    !mixedPermissions && (
                      <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ),
                  )}
                  <SelectValue>
                    {mixedPermissions
                      ? "複数の値"
                      : runtimeModeConfig[settings.defaultRuntimeMode].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {ja(
                    runtimeModeOptions.map((mode) => {
                      const option = runtimeModeConfig[mode];
                      const Icon = option.icon;
                      return (
                        <SelectItem key={mode} value={mode} className="min-w-64">
                          <div className="grid gap-0.5">
                            <span className="inline-flex items-center gap-1.5 font-medium">
                              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                              {ja(option.label)}
                            </span>
                            <span className="text-xs leading-4 text-muted-foreground">
                              {ja(option.description)}
                            </span>
                          </div>
                        </SelectItem>
                      );
                    }),
                  )}
                </SelectPopup>
              </Select>
            }
          />
          {ja(workspaceRow)}
          <SettingsRow
            serverScoped
            settingKeys={["worktreeSubmodules"]}
            mixed={mixedSubmodules}
            {...searchableSetting("worktree-submodules")}
            description={
              isProjectScope
                ? "このプロジェクトの新しいワークツリーでのサブモジュールの取得方法です。"
                : "新しいワークツリーのGitサブモジュールの取得方法です。プロジェクトやt3.jsonで変更できます。"
            }
            resetAction={
              !isProjectScope && settings.worktreeSubmodules !== null ? (
                <SettingResetButton
                  label="ワークツリーのサブモジュール"
                  onClick={() => updateSettings({ worktreeSubmodules: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedSubmodules ? null : (effective?.worktreeSubmodules ?? null)}
                onValueChange={(value) => {
                  if (isWorktreeSubmodules(value)) updateSettings({ worktreeSubmodules: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="ワークツリーのサブモジュール">
                  <SelectValue>
                    {ja((value: string | null) =>
                      isWorktreeSubmodules(value)
                        ? WORKTREE_SUBMODULES_LABELS[value]
                        : unavailable
                          ? "Unavailable"
                          : "Mixed",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {ja(
                    WORKTREE_SUBMODULES_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {ja(WORKTREE_SUBMODULES_LABELS[option])}
                      </SelectItem>
                    )),
                  )}
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : category === "source-control" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultAutoPull"]}
            mixed={mixedAutoPull}
            id="automatic-pull"
            title="自動でプル"
            description={
              isProjectScope
                ? "ローカルの変更やコミットがないとき、このプロジェクトの既定のブランチを最新に保ちます。"
                : "ローカルの変更やコミットがないとき、既定のブランチを最新に保ちます。プロジェクトごとに変更できます。"
            }
            resetAction={
              settings.defaultAutoPull ? (
                <SettingResetButton
                  label="既定の自動プル"
                  tooltip="自動プルをオフに戻す"
                  onClick={() => updateSettings({ defaultAutoPull: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label="既定の自動プル"
                mixed={mixedAutoPull}
                checked={mixedAutoPull ? false : settings.defaultAutoPull}
                onCheckedChange={(enabled) => updateSettings({ defaultAutoPull: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["pullRequestMergeMethod"]}
            mixed={mixedMergeMethod}
            {...searchableSetting("pull-request-merge-method")}
            description={
              isProjectScope
                ? "このプロジェクトのプルリクエストに使うマージ方法です。"
                : "プルリクエストに使うマージ方法です。前回の選択を使う場合、このデバイスで最後に選んだ方法を使います。"
            }
            resetAction={
              settings.pullRequestMergeMethod !== null ? (
                <SettingResetButton
                  label="既定のマージ方法"
                  tooltip="前回の選択に戻す"
                  onClick={() => updateSettings({ pullRequestMergeMethod: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedMergeMethod ? null : (settings.pullRequestMergeMethod ?? "last")}
                onValueChange={(value) => {
                  if (value === "last") updateSettings({ pullRequestMergeMethod: null });
                  else if (value === "merge" || value === "squash" || value === "rebase")
                    updateSettings({ pullRequestMergeMethod: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="プルリクエストの既定のマージ方法">
                  <SelectValue>
                    {ja((value: string | null) =>
                      value === "merge" || value === "squash" || value === "rebase"
                        ? PULL_REQUEST_MERGE_METHOD_LABELS[value]
                        : value === "last"
                          ? "Last selected"
                          : "Mixed",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="last">前回の選択</SelectItem>
                  <SelectItem value="merge">
                    {ja(PULL_REQUEST_MERGE_METHOD_LABELS.merge)}
                  </SelectItem>
                  <SelectItem value="squash">
                    {ja(PULL_REQUEST_MERGE_METHOD_LABELS.squash)}
                  </SelectItem>
                  <SelectItem value="rebase">
                    {ja(PULL_REQUEST_MERGE_METHOD_LABELS.rebase)}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["enableAgentBrowserAccess"]}
            mixed={mixedBrowser}
            id={searchableSetting("agent-browser-access").id}
            title="エージェントのブラウザ操作"
            description={
              isProjectScope
                ? "このプロジェクトのエージェントに共有ブラウザの利用を許可します。次回のセッション開始時に反映します。"
                : "エージェントに共有ブラウザの利用を許可します。プロジェクトごとに変更できます。"
            }
            resetAction={
              settings.enableAgentBrowserAccess !==
              DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
                <SettingResetButton
                  label="既定のブラウザ操作権限"
                  onClick={() =>
                    updateSettings({
                      enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                aria-label="エージェントのブラウザ操作"
                mixed={mixedBrowser}
                checked={mixedBrowser ? false : settings.enableAgentBrowserAccess}
                onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
              />
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
