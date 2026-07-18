import type { AgentRunStatus, RunKind } from "./agent-lifecycle.js";
import type { AgentEffectiveConfig, AgentRunSnapshot, AgentSnapshot } from "./agent-snapshot.js";
import type { ConversationId } from "./conversation-id.js";
import type { RunId } from "./run-id.js";

export interface AgentResult {
  conversationId: ConversationId;
  runId: RunId;
  agent: string;
  label?: string;
  prompt: string;
  kind: RunKind;
  status: AgentRunStatus;
  output?: string;
  error?: string;
  model?: string;
  effectiveConfig?: AgentEffectiveConfig;
  turns: number;
  tokens: number;
  elapsedMs: number;
  acknowledged: boolean;
}

export function toResult(snapshot: AgentSnapshot, runId: RunId = snapshot.runs.at(-1)!.runId): AgentResult {
  const run = snapshot.runs.find(candidate => candidate.runId === runId);
  if (!run) throw new Error(`Unknown run ${runId}.`);
  const done = run.status.kind === "done" ? run.status : undefined;
  return {
    conversationId: snapshot.conversationId, runId, agent: snapshot.config.name,
    ...(snapshot.label ? { label: snapshot.label } : {}), prompt: run.prompt, kind: run.kind,
    status: done?.outcome ?? "error",
    ...(done?.output !== undefined ? { output: done.output } : {}),
    ...(done?.error !== undefined ? { error: done.error } : {}),
    ...(snapshot.config.model ? { model: snapshot.config.model } : {}),
    ...(snapshot.effectiveConfig ? { effectiveConfig: snapshot.effectiveConfig } : {}),
    turns: run.activity.turns, tokens: run.usage?.totalTokens ?? 0,
    elapsedMs: done?.startedAt === undefined ? 0 : done.completedAt - done.startedAt,
    acknowledged: run.acknowledged,
  };
}

export type ResultEntry = { snapshot: AgentSnapshot; runId?: RunId } | { conversationId: ConversationId; runId: RunId; error: string };
