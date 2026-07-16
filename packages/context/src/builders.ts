import { readFileSync } from "node:fs";
import {
  buildSessionContext,
  estimateTokens as estimateMessageTokens,
  getAgentDir,
  SettingsManager,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  CompactionDetails,
  ContextReport,
  ConversationDetails,
  ConversationStats,
  MemoryDetails,
  ModelDetails,
  SkillDetails,
  ToolDetails,
  ToolSource,
} from "./types.js";

type AgentMessage = Parameters<typeof estimateMessageTokens>[0];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export function buildContextReport(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  compaction = collectCompactionDetails(ctx),
): ContextReport | undefined {
  const usage = ctx.getContextUsage();
  if (!usage) {
    return undefined;
  }

  const systemPrompt = ctx.getSystemPrompt() ?? "";
  const promptOptions = ctx.getSystemPromptOptions();
  const model: ModelDetails = {
    provider: ctx.model?.provider ?? "Unknown Provider",
    id: ctx.model?.id ?? "unknown-model",
    name: ctx.model?.name ?? ctx.model?.id ?? "unknown-model",
    thinking: pi.getThinkingLevel(),
    contextWindow: usage.contextWindow ?? ctx.model?.contextWindow,
  };

  return {
    kind: "conversation",
    model,
    usage,
    compaction,
    promptTokens: estimateTokens(systemPrompt),
    tools: collectToolDetails(pi, promptOptions, systemPrompt),
    skills: collectSkillDetails(pi, promptOptions, systemPrompt),
    memory: collectMemoryDetails(promptOptions, systemPrompt),
    snapshot: { capturedAt: Date.now() },
    conversation: collectConversationDetails(ctx),
  };
}

export function collectCompactionDetails(ctx: ExtensionCommandContext): CompactionDetails {
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  }).getCompactionSettings();
  return {
    enabled: settings.enabled,
    reserveTokens: settings.reserveTokens,
  };
}

export function estimateTokens(text: unknown): number {
  if (typeof text === "string") {
    return Math.ceil(text.length / 4);
  }
  return Math.ceil(JSON.stringify(text ?? "").length / 4);
}

export function collectSkillDetails(
  pi: ExtensionAPI,
  promptOptions?: BuildSystemPromptOptions,
  systemPrompt?: string,
): SkillDetails[] {
  const details: SkillDetails[] = [];
  if (promptOptions?.selectedTools && !promptOptions.selectedTools.includes("read")) {
    return details;
  }

  const skills = promptOptions
    ? (promptOptions.skills ?? []).filter((skill) => !skill.disableModelInvocation)
    : pi.getCommands().filter((cmd) => cmd.source === "skill");

  const visited = new Set<string>();
  skills.forEach((skill) => {
    const key = `${skill.name}-${skill.sourceInfo.scope}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);

    let content = "";
    const path = "filePath" in skill && typeof skill.filePath === "string"
      ? skill.filePath
      : skill.sourceInfo.path;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      // Missing skill files should not make /context fail.
    }

    const promptEntry = [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description ?? "")}</description>`,
      `    <location>${escapeXml(path)}</location>`,
      "  </skill>",
    ].join("\n");
    if (systemPrompt !== undefined && !systemPrompt.includes(promptEntry)) return;

    details.push({
      name: skill.name,
      descTokens: estimateTokens(promptEntry),
      bodyTokens: estimateTokens(content),
      scope: skill.sourceInfo.scope === "project" ? "project" : "user",
    });
  });

  details.sort((a, b) => b.descTokens - a.descTokens || a.name.localeCompare(b.name));
  return details;
}

export function collectToolDetails(
  pi: ExtensionAPI,
  promptOptions?: BuildSystemPromptOptions,
  systemPrompt?: string,
): ToolDetails[] {
  const active = pi.getActiveTools();
  const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const promptParts = collectToolPromptParts(tools, active, promptOptions, systemPrompt);
  const details: ToolDetails[] = [];

  for (const tool of tools.values()) {
    const source = tool.sourceInfo.source;
    let detailSource: ToolSource;
    if (source === "builtin" || /^<builtin:/i.test(tool.sourceInfo.path)) {
      detailSource = { kind: "builtin" };
    } else if (/^mcp_/i.test(tool.name) || /mcp/i.test(source)) {
      detailSource = { kind: "mcp", name: source };
    } else {
      detailSource = { kind: "extension", name: source };
    }

    const definitionTokens = estimateTokens({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    const parts = promptParts.get(tool.name) ?? [];
    const promptTokens = parts.length > 0 ? estimateTokens(parts.join("\n")) : 0;
    details.push({
      name: tool.name,
      tokens: definitionTokens + promptTokens,
      definitionTokens,
      promptTokens,
      source: detailSource,
      active: active.includes(tool.name),
    });
  }

  details.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  return details;
}

function collectToolPromptParts(
  tools: Map<string, ReturnType<ExtensionAPI["getAllTools"]>[number]>,
  active: string[],
  promptOptions?: BuildSystemPromptOptions,
  systemPrompt?: string,
): Map<string, string[]> {
  const parts = new Map<string, string[]>();
  if (!promptOptions || promptOptions.customPrompt) return parts;

  const activeNames = promptOptions.selectedTools ?? active;
  const append = (name: string, text: string): void => {
    if (systemPrompt !== undefined && !systemPrompt.includes(text)) return;
    const current = parts.get(name) ?? [];
    current.push(text);
    parts.set(name, current);
  };

  for (const name of activeNames) {
    const snippet = promptOptions.toolSnippets?.[name];
    if (snippet) append(name, `- ${name}: ${snippet}`);
  }

  const attributedGuidelines = new Set<string>();
  if (
    activeNames.includes("bash") &&
    !activeNames.some((name) => name === "grep" || name === "find" || name === "ls")
  ) {
    const guideline = "Use bash for file operations like ls, rg, find";
    append("bash", `- ${guideline}`);
    attributedGuidelines.add(guideline);
  }

  const includedGuidelines = new Set(
    (promptOptions.promptGuidelines ?? [])
      .map((guideline) => guideline.trim())
      .filter((guideline) => guideline.length > 0),
  );
  for (const name of activeNames) {
    const tool = tools.get(name);
    if (!tool) continue;

    const toolGuidelines = new Set(
      (tool.promptGuidelines ?? [])
        .map((guideline) => guideline.trim())
        .filter((guideline) => guideline.length > 0),
    );
    for (const guideline of toolGuidelines) {
      if (!includedGuidelines.has(guideline) || attributedGuidelines.has(guideline)) continue;
      append(name, `- ${guideline}`);
      attributedGuidelines.add(guideline);
    }
  }

  return parts;
}

export function collectMemoryDetails(
  promptOptions?: BuildSystemPromptOptions,
  systemPrompt?: string,
): MemoryDetails[] {
  const files = promptOptions?.contextFiles ?? [];
  const details = files.flatMap((file): MemoryDetails[] => {
    const promptEntry = `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
    if (systemPrompt !== undefined && !systemPrompt.includes(promptEntry)) return [];
    return [{ path: file.path, tokens: estimateTokens(promptEntry) }];
  });

  details.sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  return details;
}

export function collectConversationDetails(ctx: ExtensionCommandContext): ConversationDetails {
  const branch = ctx.sessionManager.getBranch();
  const messages = buildSessionContext(branch).messages;
  const stats: ConversationStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    thinkingBlocks: 0,
    imageBlocks: 0,
    compactions: branch.filter((entry) => entry.type === "compaction").length,
  };
  const toolCallCounts = new Map<string, number>();
  let tokens = 0;

  for (const message of messages) {
    tokens += estimateMessageTokens(message);

    switch (message.role) {
      case "user":
        stats.userMessages += 1;
        stats.imageBlocks += countImageBlocks(message.content);
        break;
      case "assistant":
        stats.assistantMessages += 1;
        collectAssistantStats(message, stats, toolCallCounts);
        break;
      case "toolResult":
        stats.toolResults += 1;
        stats.imageBlocks += countImageBlocks(message.content);
        break;
      case "custom":
        stats.imageBlocks += countImageBlocks(message.content);
        break;
    }
  }

  return { stats, toolCallCounts, tokens };
}

function collectAssistantStats(
  message: AssistantMessage,
  stats: ConversationStats,
  toolCallCounts: Map<string, number>,
): void {
  if (!Array.isArray(message.content)) return;

  for (const block of message.content) {
    if (block.type === "thinking") {
      stats.thinkingBlocks += 1;
    } else if (block.type === "toolCall") {
      toolCallCounts.set(block.name, (toolCallCounts.get(block.name) ?? 0) + 1);
    }
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function countImageBlocks(content: unknown): number {
  if (!Array.isArray(content)) {
    return 0;
  }

  let count = 0;
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "image") {
      count += 1;
    }
  }
  return count;
}
