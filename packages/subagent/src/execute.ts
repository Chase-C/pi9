import { readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  loadSkills,
  SessionManager,
  SettingsManager,
  stripFrontmatter,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Conversation, type Generation, type GenerationSnapshot, completedGeneration, errorGeneration, interruptedGeneration, skippedGeneration } from "./conversation.js";
import { timingAsync } from "./timing.js";

const ownExtensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

export async function discoverInheritedExtensionPaths(cwd: string, agentDir: string): Promise<string[]> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  await settingsManager.reload();

  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve();
  const ownCanonicalPath = await canonicalPath(ownExtensionPath);
  const seen = new Set<string>();
  const inherited: string[] = [];

  for (const entry of resolved.extensions) {
    if (!entry.enabled) continue;
    const canonical = await canonicalPath(entry.path);
    if (canonical === ownCanonicalPath || seen.has(canonical)) continue;
    seen.add(canonical);
    inherited.push(entry.path);
  }

  return inherited;
}

async function canonicalPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return path.resolve(file);
  }
}

export interface ExecuteGenerationDependencies {
  ResourceLoader: typeof DefaultResourceLoader;
  getAgentDir: typeof getAgentDir;
  createAgentSession: typeof createAgentSession;
  sessionManager: typeof SessionManager.inMemory;
  settingsManager: typeof SettingsManager.create;
  loadSkills: typeof loadSkills;
  readSkillFile: typeof readFileSync;
  loadExtensionPaths: (cwd: string, agentDir: string) => Promise<string[]>;
  childToolFor?: (agent: Conversation) => ToolDefinition;
  childSessionEvent?: (agent: Conversation, generation: Generation, event: AgentSessionEvent) => void;
}

export const DEFAULT_EXECUTE_GENERATION_DEPENDENCIES: ExecuteGenerationDependencies = {
  ResourceLoader: DefaultResourceLoader,
  getAgentDir,
  createAgentSession,
  sessionManager: SessionManager.inMemory,
  settingsManager: SettingsManager.create,
  loadSkills,
  readSkillFile: readFileSync,
  loadExtensionPaths: discoverInheritedExtensionPaths,
};

export async function executeGeneration(
  ctx: ExtensionContext,
  agent: Conversation,
  generation: Generation,
  signal?: AbortSignal,
  dependencies: ExecuteGenerationDependencies = DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
): Promise<GenerationSnapshot> {
  if (generation.kind === "resume") {
    const session = agent.sessionForResume();
    if (!session) {
      throw new Error(`Cannot resume an agent without a conversation session.`);
    }
    agent.bindSession(generation, session);
    return promptAgent(session, agent, generation, signal, dependencies.childSessionEvent);
  }

  if (signal?.aborted) return skippedGeneration(agent, generation);

  const generationData = { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parentConversationId, spawnedInGeneration: agent.spawnedInGeneration };
  const requestedConfig = agent.requestedConfig;
  const cwdResolution = resolveTaskCwd(ctx.cwd, requestedConfig.cwd);
  if (!cwdResolution.ok) return errorGeneration(agent, generation, cwdResolution.error);
  const modelResolution = resolveModel(requestedConfig.model, ctx.model, ctx.modelRegistry);
  if (!modelResolution.ok) return errorGeneration(agent, generation, modelResolution.error);

  const cwd = cwdResolution.value;
  const selectedModel = modelResolution.value;
  const agentDir = dependencies.getAgentDir();

  const requestedSkills = requestedConfig.skills ?? [];
  let skillBlocks = agent.resolvedSkillBlocks;
  if (skillBlocks === undefined) {
    const skillResolution = resolveRequestedSkills(cwd, requestedSkills, dependencies);
    if (!skillResolution.ok) return errorGeneration(agent, generation, skillResolution.error);
    skillBlocks = skillResolution.value;
  }
  let systemPrompt = agent.definition.systemPrompt;
  if (skillBlocks.length > 0) {
    systemPrompt = `${systemPrompt}\n\n${skillBlocks.join("\n\n")}`;
  }

  const inheritedExtensionPaths = await dependencies.loadExtensionPaths(cwd, agentDir);
  const childTool = dependencies.childToolFor?.(agent);

  const resourceLoader = new dependencies.ResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    additionalExtensionPaths: inheritedExtensionPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });

  await timingAsync("generation.resourceLoader.reload", { ...generationData, cwd }, () => resourceLoader.reload());
  if (signal?.aborted) return skippedGeneration(agent, generation);

  const requestedThinking = requestedConfig.thinking;
  const sessionManager = dependencies.sessionManager(cwd);
  const settingsManager = dependencies.settingsManager(cwd, agentDir);
  const { session } = await timingAsync("generation.createAgentSession", { ...generationData, cwd, model: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined }, () => dependencies.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    model: selectedModel,
    thinkingLevel: requestedThinking,
    tools: requestedConfig.tools ? [...requestedConfig.tools] : undefined,
    customTools: childTool ? [childTool] : [],
    sessionManager,
    settingsManager,
  }));

  const effectiveModel = session.model ?? selectedModel;
  const effectiveThinking = session.thinkingLevel ?? requestedThinking;
  const activeTools = typeof session.getActiveToolNames === "function"
    ? session.getActiveToolNames()
    : requestedConfig.tools ?? [];
  agent.setEffectiveConfig({
    ...(effectiveModel ? { model: `${effectiveModel.provider}/${effectiveModel.id}` } : {}),
    ...(effectiveThinking ? { thinking: effectiveThinking as ModelThinkingLevel } : {}),
    cwd,
    skills: requestedSkills,
    tools: activeTools,
  });

  if (signal?.aborted) {
    await AbortSession(session);
    return skippedGeneration(agent, generation);
  }

  agent.bindSession(generation, session);
  return promptAgent(session, agent, generation, signal, dependencies.childSessionEvent);
}

async function promptAgent(
  session: AgentSession,
  agent: Conversation,
  generation: Generation,
  signal?: AbortSignal,
  onSessionEvent?: (agent: Conversation, generation: Generation, event: AgentSessionEvent) => void,
): Promise<GenerationSnapshot> {
  const prompt = generation.prompt;
  const onAbort = () => { void AbortSession(session); }

  if (signal?.aborted) {
    await AbortSession(session);
    return interruptedGeneration(agent, generation, "Agent interrupted.");
  }

  signal?.addEventListener("abort", onAbort, { once: true });
  const unsubscribe = onSessionEvent ? session.subscribe(event => onSessionEvent(agent, generation, event)) : undefined;

  try {
    await timingAsync("generation.session.prompt", { agent: agent.agentName, conversationId: agent.conversationId, promptLength: prompt.length }, () => session.prompt(prompt));
    const finalMessage = GetFinalAssistantMessage(session);
    if (finalMessage.stopReason === "aborted") {
      return interruptedGeneration(agent, generation, finalMessage.errorMessage || "Agent interrupted.");
    }
    if (finalMessage.stopReason === "error") {
      return errorGeneration(agent, generation, finalMessage.errorMessage || finalMessage.response || "Agent failed.");
    }

    return completedGeneration(agent, generation, finalMessage.response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return signal?.aborted
      ? interruptedGeneration(agent, generation, message)
      : errorGeneration(agent, generation, message);
  } finally {
    unsubscribe?.();
    signal?.removeEventListener("abort", onAbort);
  }
}

async function AbortSession(session: AgentSession) {
  await Promise.resolve(session.abort()).catch(() => undefined);
}

export type GenerationExecutionResolution<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

type SkillResolutionDependencies = Pick<
  ExecuteGenerationDependencies,
  "getAgentDir" | "loadSkills" | "readSkillFile"
>;

export function resolveRequestedSkills(
  cwd: string,
  requestedSkills: readonly string[],
  dependencies: SkillResolutionDependencies = DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
): GenerationExecutionResolution<readonly string[]> {
  if (requestedSkills.length === 0) return { ok: true, value: [] };

  let available: Skill[];
  try {
    const agentDir = dependencies.getAgentDir();
    available = dependencies.loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not discover requested skills: ${message}` };
  }

  const matched: Skill[] = [];
  for (const name of requestedSkills) {
    const found = available.find(skill => skill.name === name);
    if (!found) return { ok: false, error: `Unknown skill: ${name}` };
    matched.push({ ...found, disableModelInvocation: false });
  }

  try {
    return {
      ok: true,
      value: matched.map(skill => {
        const content = dependencies.readSkillFile(skill.filePath, "utf-8");
        const body = stripFrontmatter(content).trim();
        return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not load requested skill: ${message}` };
  }
}

export function resolveTaskCwd(
  parentCwd: string,
  requestedCwd: string | undefined,
): GenerationExecutionResolution<string> {
  if (requestedCwd === undefined) return { ok: true, value: parentCwd };

  const cwd = path.resolve(parentCwd, requestedCwd);
  try {
    if (!statSync(cwd).isDirectory()) {
      return { ok: false, error: `Working directory is not a directory: ${cwd}` };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, error: `Working directory does not exist: ${cwd}` };
    if (code === "ENOTDIR") return { ok: false, error: `Working directory is not a directory: ${cwd}` };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not access working directory ${cwd}: ${message}` };
  }

  return { ok: true, value: cwd };
}

export function resolveModel(
  requestedModel: string | undefined,
  parentModel: Model<any> | undefined,
  registry: ModelRegistry,
): GenerationExecutionResolution<Model<any> | undefined> {
  if (requestedModel === undefined) return { ok: true, value: parentModel };

  const parts = requestedModel.split("/");
  if (parts.some(part => part.trim().length === 0)) {
    return {
      ok: false,
      error: `Invalid model "${requestedModel}": model references cannot be blank or contain empty slash-delimited parts.`,
    };
  }

  const models = registry.getAll();
  const canonical = models.find(model => `${model.provider}/${model.id}` === requestedModel);
  if (canonical) return { ok: true, value: canonical };

  const candidates = models.filter(model => model.id === requestedModel);
  const sameProvider = candidates.find(model => model.provider === parentModel?.provider);
  if (sameProvider) return { ok: true, value: sameProvider };
  if (candidates.length === 1) return { ok: true, value: candidates[0] };
  if (candidates.length > 1) {
    const matches = candidates.map(model => `${model.provider}/${model.id}`).join(", ");
    return {
      ok: false,
      error: `Ambiguous model "${requestedModel}": matches ${matches}. Use a provider-qualified model reference.`,
    };
  }

  return { ok: false, error: `Unknown model: ${requestedModel}` };
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
