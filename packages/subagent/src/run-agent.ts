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

export interface RunResult {
  response: string;
  session: AgentSession;
  error?: string;
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
): Promise<RunResult> {
  ThrowIfAbortedBeforeStart(agent, signal);

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
  ThrowIfAbortedBeforeStart(agent, signal);

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
    agent.cancelQueued();
    throw new Error("Agent skipped.");
  }

  agent.start(session);
  return PromptAgent(session, agent, agent.options.prompt, signal);
}

export async function ResumeAgent(
  _ctx: ExtensionContext,
  agent: Agent,
  prompt: string,
  signal?: AbortSignal,
): Promise<RunResult> {
  if (agent.status.kind !== "completed") {
    throw new Error(`Cannot resume an agent that is ${agent.status.kind}.`);
  }

  const session = agent.status.session;
  agent.resume(session);
  return PromptAgent(session, agent, prompt, signal);
}

async function PromptAgent(
  session: AgentSession,
  agent: Agent,
  prompt: string,
  signal?: AbortSignal,
): Promise<RunResult> {
  const onAbort = () => {
    void AbortSession(session);
    if (agent.status.kind === "running") agent.interrupt("Agent interrupted.");
  }

  if (signal?.aborted) {
    await AbortSession(session);
    agent.interrupt("Agent interrupted.");
    throw new Error("Agent interrupted.");
  }

  signal?.addEventListener("abort", onAbort, { once: true });
  const { getMessage, unsubscribe } = SubscribeToSession(session, agent);

  try {
    await session.prompt(prompt);
    const finalMessage = GetFinalAssistantMessage(session);
    if (finalMessage.stopReason === "aborted") {
      const message = finalMessage.errorMessage || "Agent interrupted.";
      if (agent.status.kind === "running") agent.interrupt(message);
      throw new Error(message);
    }
    if (finalMessage.stopReason === "error") {
      agent.error(finalMessage.errorMessage || finalMessage.response || "Agent failed.");
      throw new Error(finalMessage.errorMessage || "Agent failed.");
    }

    const response = getMessage() || finalMessage.response;

    agent.complete(response);
    return { response, session };
  } catch (error) {
    if (agent.status.kind === "running") {
      const message = error instanceof Error ? error.message : String(error);
      if (signal?.aborted) agent.interrupt(message);
      else agent.error(message);
    }
    throw error;
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
  }
}

function ThrowIfAbortedBeforeStart(agent: Agent, signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  agent.cancelQueued();
  throw new Error("Agent skipped.");
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

function SubscribeToSession(
  session: AgentSession,
  agent: Agent,
) {
  let message = "";
  const unsubscribe = session.subscribe(event => {
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      agent.compacted();
    }
    else if (event.type === "message_start") {
      message = "";
    }
    else if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      if (message.role === "assistant") {
        agent.usageUpdated(message.usage);
      }
    }
    else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      message += event.assistantMessageEvent.delta;
      agent.messageUpdated(message);

    }
    else if (event.type === "tool_execution_start") {
      agent.toolStarted(event.toolName);
    }
    else if (event.type === "tool_execution_end") {
      agent.toolEnded();
    }
    else if (event.type === "turn_end") {
      agent.turnEnded();
    }
  });

  return { getMessage: () => message, unsubscribe };
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
