import { ja, jaTemplate } from "../../lib/ja";
import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";

/** Summarize observed states without treating idle or missing agents as completed. */
export function deriveAgentSpawnSummary({
  agents,
  agentCount,
  coordinatorStatus,
}: {
  agents: ReadonlyArray<Pick<RuntimeSubagent, "kind" | "status">>;
  agentCount: number;
  coordinatorStatus?: RuntimeSubagent["status"] | undefined;
}) {
  const working = agents.filter((agent) => isActiveSubagentStatus(agent.status)).length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const stopped = agents.filter(
    (agent) => agent.status === "cancelled" || agent.status === "interrupted",
  ).length;
  const batches = agents.filter((agent) => agent.kind === "subagent_batch").length;
  const individuals = agentCount - batches;
  // Workflow coordinators can keep running between dynamic member launches.
  const live =
    coordinatorStatus !== undefined ? !isTerminalSubagentStatus(coordinatorStatus) : working > 0;
  const subjects = [
    individuals > 0 ? jaTemplate`${individuals} subagents` : null,
    batches > 0 ? jaTemplate`${batches} subagent batches` : null,
  ]
    .filter(Boolean)
    .join("、");
  const subject = subjects || ja("subagents");
  const lead =
    batches > 0
      ? jaTemplate`Launched ${subject}`
      : live
        ? jaTemplate`Kicked off ${subject}`
        : jaTemplate`Ran ${subject}`;

  const status = live
    ? working > 0
      ? `${working} working`
      : "working"
    : coordinatorStatus === "failed"
      ? "Workflow failed"
      : coordinatorStatus === "cancelled" || coordinatorStatus === "interrupted"
        ? "Workflow stopped"
        : failed > 0
          ? `${failed} failed`
          : stopped > 0
            ? `${stopped} stopped`
            : idle > 0
              ? `${idle} idle`
              : coordinatorStatus !== "completed" &&
                  (agents.length === 0 || agents.length < agentCount)
                ? "Status unavailable"
                : "✓ completed";
  const tone = live
    ? "working"
    : failed > 0 || coordinatorStatus === "failed"
      ? "failed"
      : status === "✓ completed"
        ? "completed"
        : "inactive";
  const displayStatus = live
    ? working > 0
      ? jaTemplate`${working} working`
      : ja("working")
    : coordinatorStatus === "failed"
      ? ja("Workflow failed")
      : coordinatorStatus === "cancelled" || coordinatorStatus === "interrupted"
        ? ja("Workflow stopped")
        : failed > 0
          ? jaTemplate`${failed} failed`
          : stopped > 0
            ? jaTemplate`${stopped} stopped`
            : idle > 0
              ? jaTemplate`${idle} idle`
              : ja(status);
  return { live, lead, status: displayStatus, tone };
}
