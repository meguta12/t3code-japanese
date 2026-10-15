import {
  DEFAULT_SERVER_SETTINGS,
  type DelegationPreset,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  isPresetModelOffered,
  nextPresetName,
  normalizePresetName,
  validatePresetName,
} from "../../lib/delegation";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { randomUUID } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScopedSwitch } from "./ScopedSwitch";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const NAME_PROBLEM_MESSAGES = {
  empty: "名前が空のため保存されていません。",
  duplicate: "同じ名前の役割があるため保存されていません。",
} as const;

function PresetRow({
  preset,
  presets,
  entries,
  onChange,
  onRemove,
}: {
  readonly preset: DelegationPreset;
  readonly presets: ReadonlyArray<DelegationPreset>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onChange: (next: DelegationPreset) => void;
  readonly onRemove: () => void;
}) {
  const settings = useScopedSettings();
  const navigate = useNavigate();
  const { environment } = useSettingsScope();
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const selection = preset.modelSelection;
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const optionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );
  const offered = isPresetModelOffered({
    entry,
    options: optionsByInstance.get(selection.instanceId),
    model: selection.model,
  });

  // Typing is a draft; the list is saved when the field loses focus and the
  // name is usable, so a half-typed duplicate never reaches the server. The
  // row is keyed by its saved name, so a saved or external rename resets it.
  const [draft, setDraft] = useState(preset.name);
  const problem = validatePresetName(draft, preset.id, presets);
  const commitName = () => {
    if (problem !== null) return;
    const name = normalizePresetName(draft);
    if (name !== preset.name) onChange({ ...preset, name });
  };
  const setModel = (value: ModelSelection) => onChange({ ...preset, modelSelection: value });

  return (
    <div className="space-y-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-36 shrink-0">
          <Input
            size="sm"
            aria-label="役割の名前"
            aria-invalid={problem !== null}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>
        <ProviderModelPicker
          activeInstanceId={selection.instanceId}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={optionsByInstance}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          triggerAriaLabel={`${preset.name}のモデル`}
          getModelDisabledReason={modelDisabledReason}
          onOpenProviderSetup={(instanceId: ProviderInstanceId) => {
            if (environment)
              void navigate({
                to: "/settings/providers",
                search: { environmentId: environment.environmentId, instanceId },
              });
          }}
          onInstanceModelChange={(instanceId, model) => {
            const reason = modelDisabledReason(instanceId, model);
            if (reason === null) setModel(createModelSelection(instanceId, model));
          }}
        />
        {entry ? (
          <TraitsPicker
            provider={entry.driverKind}
            instanceId={entry.instanceId}
            models={entry.models}
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
        {offered ? null : (
          <Badge variant="warning" size="sm">
            このモデルは現在利用できません
          </Badge>
        )}
        <Button
          size="icon-sm"
          variant="ghost-destructive"
          type="button"
          aria-label={`${preset.name}を削除`}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      {problem !== null ? (
        <p className="text-xs text-destructive-foreground">{NAME_PROBLEM_MESSAGES[problem]}</p>
      ) : null}
    </div>
  );
}

/**
 * The 「エージェントの委譲」 section: the on/off switch and the named role
 * presets an agent can hand work to ("実装役に回して"). Both are server-wide
 * settings, so a single environment is edited at a time.
 */
export function DelegationSettings() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedPresets = useScopedSettingsMixed(["delegationPresets"]);
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const presets = settings.delegationPresets;
  const environmentWide = scope.kind === "project" || scope.kind === "checkout";
  const defaultSelection = resolveDefaultProviderModelSelection(
    providers,
    settings.defaultModelSelection,
  );
  const savePresets = (next: ReadonlyArray<DelegationPreset>) =>
    updateSettings({ delegationPresets: next });
  const addPreset = () => {
    if (defaultSelection === null) return;
    savePresets([
      ...presets,
      {
        id: randomUUID(),
        name: nextPresetName(presets),
        modelSelection: defaultSelection,
      },
    ]);
  };

  return (
    <SettingsSection id="agent-delegation-section" title="エージェントの委譲">
      <SettingsRow
        serverScoped
        settingKeys={["enableAgentDelegation"]}
        {...searchableSetting("agent-delegation")}
        description="エージェントが別のモデルや強さを選び、子のチャットに作業を任せられるようにします。すぐに反映します。"
        resetAction={
          settings.enableAgentDelegation !== DEFAULT_SERVER_SETTINGS.enableAgentDelegation ? (
            <SettingResetButton
              label="エージェントの委譲"
              onClick={() =>
                updateSettings({
                  enableAgentDelegation: DEFAULT_SERVER_SETTINGS.enableAgentDelegation,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["enableAgentDelegation"]}
            aria-label="エージェントの委譲"
            checked={settings.enableAgentDelegation}
            onCheckedChange={(enabled) => updateSettings({ enableAgentDelegation: enabled })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["delegationPresets"]}
        {...searchableSetting("delegation-presets")}
        description="チャットで「実装役に回して」「レビュー役でお願い」と言うと、その役割のモデルに作業を任せます。"
        control={
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={
              environmentWide ||
              mixedPresets ||
              connectedEnvironments.length === 0 ||
              defaultSelection === null
            }
            onClick={addPreset}
          >
            <PlusIcon />
            モデルを追加
          </Button>
        }
      >
        {mixedPresets ? (
          <p className="pb-2 text-xs text-muted-foreground">
            選んだ環境で役割の設定が異なります。環境を1つ選んで編集してください。
          </p>
        ) : presets.length === 0 ? (
          <p className="pb-2 text-xs text-muted-foreground">
            役割はまだありません。「モデルを追加」で作ると、名前でモデルを呼び出せます。
          </p>
        ) : (
          <div inert={environmentWide} className="divide-y divide-border/60">
            {presets.map((preset) => (
              <PresetRow
                key={`${preset.id}:${preset.name}`}
                preset={preset}
                presets={presets}
                entries={entries}
                onChange={(next) =>
                  savePresets(presets.map((item) => (item.id === next.id ? next : item)))
                }
                onRemove={() => savePresets(presets.filter((item) => item.id !== preset.id))}
              />
            ))}
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
