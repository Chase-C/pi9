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

import { Agent } from "../domain/agent.js";
import {
  completedRun,
  errorRun,
  finalizeRun,
  interruptedRun,
  type AgentRunResult,
} from "../domain/agent-result.js";

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
  prompt: string,
  signal?: AbortSignal,
  dependencies: RunAgentDependencies = DefaultRunAgentDependencies,
): Promise<AgentRunResult> {
  if (signal?.aborted) return finalizeRun(agent, prompt, { status: "skipped", error: "Agent skipped." });

  const cwd = ResolveTaskCwd(ctx.cwd, agent.cwd);
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
  if (signal?.aborted) return finalizeRun(agent, prompt, { status: "skipped", error: "Agent skipped." });

  const { session } = await dependencies.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    model: SelectModel(agent.modelOverride ?? agent.config.model, ctx.model, ctx.modelRegistry),
    thinkingLevel: agent.thinkingOverride ?? agent.config.thinking,
    modelRegistry: ctx.modelRegistry,
    tools: agent.config.tools,
    sessionManager: dependencies.sessionManager(cwd),
    settingsManager: dependencies.settingsManager(cwd, agentDir),
  });

  if (signal?.aborted) {
    await AbortSession(session);
    return finalizeRun(agent, prompt, { status: "skipped", error: "Agent skipped." });
  }

  agent.attach(session);
  return PromptAgent(session, agent, prompt, signal);
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
    return interruptedRun(agent, prompt, "Agent interrupted.");
  }

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await session.prompt(prompt);
    const finalMessage = GetFinalAssistantMessage(session);
    if (finalMessage.stopReason === "aborted") {
      return interruptedRun(agent, prompt, finalMessage.errorMessage || "Agent interrupted.");
    }
    if (finalMessage.stopReason === "error") {
      return errorRun(agent, prompt, finalMessage.errorMessage || finalMessage.response || "Agent failed.");
    }

    const response = agent.message || finalMessage.response;
    return completedRun(agent, prompt, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return signal?.aborted
      ? interruptedRun(agent, prompt, message)
      : errorRun(agent, prompt, message);
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
