import path from "node:path";

import type { Model } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ExtensionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";

import { Agent } from "./agent.js";

export interface AgentRunResult {
  agent: string;
  prompt: string;
  status: "completed" | "error" | "aborted" | "skipped" | "interrupted";
  output?: string;
  error?: string;
  model?: string;
  sessionId?: string;
  resumable: boolean;
}

export interface FinalizeRunArgs {
  status: AgentRunResult["status"];
  output?: string;
  error?: string;
  prompt?: string;
}

export function finalizeRun(agent: Agent, args: FinalizeRunArgs): AgentRunResult {
  const prompt = args.prompt ?? agent.options.prompt;
  const hasSession = args.status === "completed"
    ? true
    : args.status === "skipped"
      ? false
      : hasSessionAttached(agent);
  const resumable = Boolean(agent.config.resumable && hasSession);
  const result: AgentRunResult = {
    agent: agent.options.agent,
    prompt,
    model: agent.options.model ?? agent.config.model,
    resumable,
    status: args.status,
    ...(resumable ? { sessionId: agent.id } : {}),
    ...(args.output !== undefined ? { output: args.output } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
  };
  agent.finalize(result);
  return result;
}

export const completedRun = (agent: Agent, output: string, prompt?: string): AgentRunResult =>
  finalizeRun(agent, { status: "completed", output, prompt });

export const errorRun = (agent: Agent, error: string, prompt?: string): AgentRunResult =>
  finalizeRun(agent, { status: "error", error, prompt });

export const interruptedRun = (agent: Agent, error: string, prompt?: string): AgentRunResult =>
  finalizeRun(agent, { status: "interrupted", error, prompt });

function hasSessionAttached(agent: Agent): boolean {
  if (agent.status.kind === "running") return true;
  if (agent.status.kind === "done") return Boolean(agent.status.ran);
  return false;
}

export interface RunAgentDependencies {
  ResourceLoader: typeof DefaultResourceLoader;
  getAgentDir: typeof getAgentDir;
  createAgentSession: typeof createAgentSession;
  sessionManager: typeof SessionManager.inMemory;
  settingsManager: typeof SettingsManager.create;
}

const DefaultRunAgentDependencies: RunAgentDependencies = {
  ResourceLoader: DefaultResourceLoader,
  getAgentDir,
  createAgentSession,
  sessionManager: SessionManager.inMemory,
  settingsManager: SettingsManager.create,
};

export async function RunAgent(
  ctx: ExtensionContext,
  agent: Agent,
  signal?: AbortSignal,
  dependencies: RunAgentDependencies = DefaultRunAgentDependencies,
): Promise<AgentRunResult> {
  if (signal?.aborted) return finalizeRun(agent, { status: "skipped", error: "Agent skipped." });

  const cwd = ResolveTaskCwd(ctx.cwd, agent.options.cwd);
  const agentDir = dependencies.getAgentDir();

  const resourceLoader = new dependencies.ResourceLoader({
    cwd,
    agentDir,
    noExtensions: false,
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => agent.config.systemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await resourceLoader.reload();
  if (signal?.aborted) return finalizeRun(agent, { status: "skipped", error: "Agent skipped." });

  const { session } = await dependencies.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    model: SelectModel(agent.options.model ?? agent.config.model, ctx.model, ctx.modelRegistry),
    thinkingLevel: agent.options.thinking ?? agent.config.thinking,
    modelRegistry: ctx.modelRegistry,
    tools: agent.config.tools,
    sessionManager: dependencies.sessionManager(cwd),
    settingsManager: dependencies.settingsManager(cwd, agentDir),
  });

  if (signal?.aborted) {
    await AbortSession(session);
    return finalizeRun(agent, { status: "skipped", error: "Agent skipped." });
  }

  agent.attach(session);
  return PromptAgent(session, agent, agent.options.prompt, signal);
}

export async function ResumeAgent(
  _ctx: ExtensionContext,
  agent: Agent,
  prompt: string,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const session = agent.status.kind === "done" ? agent.status.ran?.session : undefined;
  if (!session) {
    throw new Error(`Cannot resume an agent without a retained session.`);
  }

  agent.attach(session);
  return PromptAgent(session, agent, prompt, signal);
}

async function PromptAgent(
  session: AgentSession,
  agent: Agent,
  prompt: string,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const onAbort = () => { void AbortSession(session); }

  if (signal?.aborted) {
    await AbortSession(session);
    return interruptedRun(agent, "Agent interrupted.", prompt);
  }

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await session.prompt(prompt);
    const finalMessage = GetFinalAssistantMessage(session);
    if (finalMessage.stopReason === "aborted") {
      return interruptedRun(agent, finalMessage.errorMessage || "Agent interrupted.", prompt);
    }
    if (finalMessage.stopReason === "error") {
      return errorRun(agent, finalMessage.errorMessage || finalMessage.response || "Agent failed.", prompt);
    }

    const response = agent.message || finalMessage.response;
    return completedRun(agent, response, prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return signal?.aborted
      ? interruptedRun(agent, message, prompt)
      : errorRun(agent, message, prompt);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function AbortSession(session: AgentSession) {
  await Promise.resolve(session.abort()).catch(() => undefined);
}

function ResolveTaskCwd(ctxCwd: string, taskCwd: string | undefined) {
  if (!taskCwd) return ctxCwd;
  return path.isAbsolute(taskCwd) ? taskCwd : path.resolve(ctxCwd, taskCwd);
}

function SelectModel(
  agentModel: string | undefined,
  parentModel: Model<any> | undefined,
  registry: ModelRegistry,
): Model<any> | undefined {
  if (!agentModel) return parentModel;

  let modelId: string;
  let provider: string | undefined;

  const parts = agentModel.split("/");
  if (parts.length == 1) {
    modelId = parts[0];
  } else if (parts.length == 2) {
    provider = parts[0];
    modelId = parts[1];
  } else {
    return parentModel;
  }

  if (provider) {
    for (const model of registry.getAll()) {
      if (model.provider == provider && model.id == modelId) return model;
    }
  } else {
    const candidates = registry.getAll().filter((model) => model.id == modelId);
    // Prefer, but do not require, the same provider as the default model
    const sameProvider = candidates.find((model) => model.provider === parentModel?.provider);
    return sameProvider ?? candidates[0] ?? parentModel;
  }

  return parentModel;
}

function GetFinalAssistantMessage(
  session: AgentSession,
): { response: string; stopReason?: string; errorMessage?: string } {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role == "assistant") {
      return {
        response: msg.content
          .filter(part => part.type === "text")
          .map(part => part.text)
          .join("\n")
          .trim() ?? "",
        stopReason: msg.stopReason,
        errorMessage: msg.errorMessage,
      };
    }
  }
  return { response: "" };
}
