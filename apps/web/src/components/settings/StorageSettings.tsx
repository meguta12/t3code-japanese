import { ja, jaTemplate } from "../../lib/ja";
import type { StorageCleanupSettings, WorktreeCleanupRules } from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useClearScopedSettings,
  useScopedSettings,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function RetentionControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <NumberField
          value={draft}
          min={1}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) setDraft(value);
            else {
              const days = Math.min(3650, Math.max(1, Math.round(next)));
              setDraft(days);
              onChange(days);
            }
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={jaTemplate`Decrease ${label}`} />
            <NumberFieldInput
              aria-label={jaTemplate`${label} in days`}
              size={new Intl.NumberFormat().format(draft ?? value).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {ja("days")}
            </span>
            <NumberFieldIncrement aria-label={jaTemplate`Increase ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">オフ</span>
      )}
      <Switch
        aria-label={ja(label)}
        checked={value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? 8 : null)}
      />
    </div>
  );
}

export function StorageSettingsPanel() {
  const { scope, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    targets.some(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ] !== settings[key],
    )
      ? "Mixed across selected machines"
      : undefined;
  const update = (patch: Partial<StorageCleanupSettings>) =>
    updateSettings({ storageCleanup: patch });
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } })
      : update(patch);

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice target="all">
        プロジェクトのワークツリー整理を設定するには、選んだマシンを更新してください。
      </SettingsScopeNotice>
    );
  }

  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.storageCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.storageCleanup === true,
          )
          .map((environment) => environment.environmentId)}
      >
        保存データの整理を使うには、環境を更新するか対応するマシンを選んでください。
      </SettingsScopeNotice>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="storage-worktrees" title="ワークツリー">
        {ja(
          isProjectScope && (
            <SettingsRow
              title="ワークツリーの自動整理"
              description={
                mode === "off"
                  ? "手動で削除するまで、このプロジェクトのワークツリーを保持します。"
                  : mode === "custom"
                    ? "このプロジェクトに以下の規則を使います。"
                    : "各マシンのワークツリー整理設定を使います。"
              }
              serverScoped
              settingKeys={["worktreeCleanup"]}
              mixed={mixedModes}
              control={
                <Select
                  value={mixedModes ? null : mode}
                  onValueChange={(next) => {
                    if (next === "inherit") clearSettings(["worktreeCleanup"]);
                    else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                    else if (next === "custom")
                      updateSettings({ worktreeCleanup: { mode: "custom", rules: {} } });
                  }}
                >
                  <SelectTrigger size="sm" aria-label="ワークツリーの自動整理">
                    <SelectValue>
                      {mixedModes
                        ? "複数の値"
                        : mode === "inherit"
                          ? "継承"
                          : mode === "off"
                            ? "オフ"
                            : "カスタム"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value="inherit">継承</SelectItem>
                    <SelectItem value="off">オフ</SelectItem>
                    <SelectItem value="custom">カスタム</SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          ),
        )}
        {ja(
          (!isProjectScope || (!mixedModes && mode === "custom")) && (
            <>
              <SettingsRow
                title="チャット削除時にワークツリーを削除"
                status={ruleStatus("worktreeOnDelete")}
                description="チャットやアーカイブの削除時に、使わなくなったワークツリーを削除します。ローカルの変更があるものは保持します。"
                serverScoped={!isProjectScope}
                control={
                  <Switch
                    aria-label="チャット削除時にワークツリーを削除"
                    checked={settings.worktreeOnDelete}
                    onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                  />
                }
              />
              <SettingsRow
                title="使っていないワークツリーを削除"
                status={ruleStatus("worktreeAfterDays")}
                description="指定した日数、チャットに操作がないワークツリーを削除します。ブランチと会話履歴は保持します。"
                serverScoped={!isProjectScope}
                control={
                  <RetentionControl
                    label="使っていないワークツリーを削除"
                    value={settings.worktreeAfterDays}
                    onChange={(worktreeAfterDays) => updateWorktree({ worktreeAfterDays })}
                  />
                }
              />
              <SettingsRow
                title="マージ済みのワークツリーを削除"
                status={ruleStatus("worktreeOnMerge")}
                description="プルリクエストがマージ済みで、コミットが既定ブランチに含まれるワークツリーを削除します。"
                serverScoped={!isProjectScope}
                control={
                  <Switch
                    aria-label="マージ済みのワークツリーを削除"
                    checked={settings.worktreeOnMerge}
                    onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                  />
                }
              />
              <SettingsRow
                title="変更のないワークツリーを削除"
                status={ruleStatus("worktreeUnchanged")}
                description="既定ブランチとの差分コミットがないワークツリーを削除します。"
                serverScoped={!isProjectScope}
                control={
                  <Switch
                    aria-label="変更のないワークツリーを削除"
                    checked={settings.worktreeUnchanged}
                    onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                  />
                }
              />
            </>
          ),
        )}
      </SettingsSection>

      {ja(
        !isProjectScope && (
          <SettingsSection id="storage-artifacts" title="成果物とログ">
            <SettingsRow
              title="古いブラウザの保存画像を削除"
              status={ruleStatus("browserArtifactsAfterDays")}
              description="指定した日数より古いブラウザキャプチャを削除します。古いキャプチャへのリンクは開けなくなります。"
              serverScoped
              control={
                <RetentionControl
                  label="古いブラウザの保存画像を削除"
                  value={settings.browserArtifactsAfterDays}
                  onChange={(browserArtifactsAfterDays) => update({ browserArtifactsAfterDays })}
                />
              }
            />
            <SettingsRow
              title="古いローテーション済みログを削除"
              status={ruleStatus("logsAfterDays")}
              description="指定した日数より古く、使われていないログを削除します。現在のログは保持します。"
              serverScoped
              control={
                <RetentionControl
                  label="古いローテーション済みログを削除"
                  value={settings.logsAfterDays}
                  onChange={(logsAfterDays) => update({ logsAfterDays })}
                />
              }
            />
          </SettingsSection>
        ),
      )}
    </SettingsPageContainer>
  );
}
