import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";

export function DelegationSuggestionControl({
  threadRef,
  isChild = false,
  disabled = false,
  size = "sm",
}: {
  readonly threadRef: ScopedThreadRef;
  readonly isChild?: boolean;
  readonly disabled?: boolean;
  readonly size?: ComposerControlSize;
}) {
  const enabled = useEnvironmentSettings(
    threadRef.environmentId,
    (settings) => settings.delegationSuggestionOverrides[threadRef.threadId] === true,
  );
  const access = useEnvironmentSettings(
    threadRef.environmentId,
    (settings) => settings.enableAgentDelegation,
  );
  const update = useUpdateEnvironmentSettings(threadRef.environmentId);
  const explanation = isChild
    ? "子からは再委譲できません。親セッションで依頼してください。"
    : !access
      ? "設定でエージェントの委譲を有効にしてください。"
      : "ON: 別モデルが役立つときだけ提案し、了承後に分けます。明示した委譲はOFFでも実行します。";
  return (
    <ComposerControl
      size={size}
      aria-pressed={enabled}
      aria-label={`委譲を提案 ${enabled ? "ON" : "OFF"}`}
      title={explanation}
      disabled={disabled || isChild || !access}
      onClick={() => update({ delegationSuggestionOverrides: { [threadRef.threadId]: !enabled } })}
      data-delegation-suggestions
    >
      <span data-composer-control-label>委譲を提案</span>
      <span className="text-3xs font-semibold">{enabled ? "ON" : "OFF"}</span>
    </ComposerControl>
  );
}
