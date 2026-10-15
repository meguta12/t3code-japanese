import {
  omitSupersededLifecycleMarkers,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  type WorkLogPresentationEntry,
} from "@t3tools/client-runtime/work-log/presentation";
import { ja, jaTemplate } from "../../lib/ja";

/** Translate generated action summaries while keeping integration names verbatim. */
export function localizedToolGroupSummary(entries: readonly WorkLogPresentationEntry[]): string {
  const groups = new Map<ReturnType<typeof toolGroupAction>, WorkLogPresentationEntry[]>();
  const sources = new Map<string, NonNullable<WorkLogPresentationEntry["toolSource"]>>();
  for (const entry of omitSupersededLifecycleMarkers(entries, (entry) => entry)) {
    if (entry.toolSource && resolveWorkEntryToolPresentation(entry)?.icon !== "pull-request") {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const action = toolGroupAction(entry);
    const group = groups.get(action);
    if (group) group.push(entry);
    else groups.set(action, [entry]);
  }
  const labels = [...groups.values()].map((group) => ja(summarizeToolGroup(group)));
  if (sources.size > 0) {
    const names = [...sources.values()].map((source) => source.name).join("、");
    labels.unshift(jaTemplate`Used ${names}`);
  }
  return labels.join("、");
}
