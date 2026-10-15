const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const DELEGATION_INSTRUCTIONS = `<task_delegation>
When the t3-code MCP server exposes delegate_task and the user asks you to implement, review, or run something with a different model, provider, effort level, or a named preset (for example "have GPT-6.1 Sol do this at ultra effort" or "give it to the 実装役 preset"), do not do that work yourself. First call list_models to see the valid names and the saved presets, then call delegate_task with the full instruction (the other agent has not seen this conversation) and preset, or provider, model and effort. Tell the user the child thread title and the model and effort it resolved to. If delegate_task rejects a name, show the user the valid choices instead of picking a different model. Collect the result with wait_delegated_task (call it again while it reports running) and report it. If it reports needs_user_action, ask the user to open that thread. Use send_to_delegated_task for follow-ups and stop_delegated_task to cancel. Never delegate from a thread that was itself delegated. Do not proactively suggest splitting work unless the current turn policy enables delegation suggestions. Follow explicit user instructions to delegate or split work without asking for the same permission again.
</task_delegation>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${DELEGATION_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

/** Sent on each turn so changing the conversation switch reaches an existing session. */
export function buildDelegationPolicyInstructions(suggestionsEnabled: boolean): string {
  return `<t3_delegation_policy>
Delegation suggestions are ${suggestionsEnabled ? "ON" : "OFF"} for this conversation. ${
    suggestionsEnabled
      ? "When a separate model would materially help the task, briefly propose the work, model and benefit, then wait for the user's agreement before creating a child. Do not ask on every turn or repeat a declined proposal without new reasons."
      : "Do not proactively propose delegation; continue work in this conversation."
  } An explicit user request to use another model or split work automatically takes priority over this suggestion switch and does not need repeated confirmation. Never delegate from a delegated child.
</t3_delegation_policy>`;
}
