import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildContextReport,
  collectConversationDetails,
  collectMemoryDetails,
  collectSkillDetails,
  collectToolDetails,
  estimateTokens,
} from "../src/builders.js";

describe("buildContextReport", () => {
  it("builds a complete report from the current command context", () => {
    const memoryPrompt = '<project_instructions path="AGENTS.md">\ncurrent rules\n</project_instructions>\n\n';
    const systemPrompt = `current prompt\n${memoryPrompt}`;
    const pi = {
      getThinkingLevel: () => "medium",
      getActiveTools: () => [],
      getAllTools: () => [],
    };
    const ctx = {
      model: {
        provider: "test-provider",
        id: "test-model",
        name: "Test Model",
        contextWindow: 10_000,
      },
      getContextUsage: () => ({ contextWindow: 10_000, tokens: 2_000, percent: 20 }),
      getSystemPrompt: () => systemPrompt,
      getSystemPromptOptions: () => ({
        cwd: "/project",
        contextFiles: [{ path: "AGENTS.md", content: "current rules" }],
        skills: [],
      }),
      sessionManager: { getBranch: () => [] },
    };

    const report = buildContextReport(
      pi as never,
      ctx as never,
      { enabled: true, reserveTokens: 1_000 },
    );

    expect(report).toMatchObject({
      kind: "conversation",
      compaction: { enabled: true, reserveTokens: 1_000 },
      promptTokens: estimateTokens(systemPrompt),
      memory: [{ path: "AGENTS.md", tokens: estimateTokens(memoryPrompt) }],
      conversation: {
        stats: { compactions: 0 },
        tokens: 0,
        history: [],
      },
    });
  });

  it("counts compactions on the current branch", () => {
    const branch = [
      {
        type: "compaction",
        id: "first",
        parentId: null,
        timestamp: "2026-07-09T00:00:00.000Z",
        summary: "First summary",
        firstKeptEntryId: "missing",
        tokensBefore: 1_000,
      },
      {
        type: "compaction",
        id: "second",
        parentId: "first",
        timestamp: "2026-07-09T01:00:00.000Z",
        summary: "Second summary",
        firstKeptEntryId: "missing",
        tokensBefore: 2_000,
      },
    ];
    const details = collectConversationDetails({
      sessionManager: { getBranch: () => branch },
    } as never);

    expect(details.stats.compactions).toBe(2);
  });

  it("attributes active tool definitions, snippets, and guidelines to the tool", () => {
    const parameters = { type: "object", properties: { input: { type: "string" } } };
    const pi = {
      getActiveTools: () => ["demo"],
      getAllTools: () => [{
        name: "demo",
        description: "Demo description",
        parameters,
        promptGuidelines: ["Use demo for demo work.", "Keep demo output short."],
        sourceInfo: {
          path: "/extensions/demo.ts",
          source: "demo-extension",
          scope: "user",
          origin: "top-level",
        },
      }],
    };
    const promptOptions = {
      cwd: "/project",
      selectedTools: ["demo"],
      toolSnippets: { demo: "Perform demo work" },
      promptGuidelines: ["Use demo for demo work.", "Keep demo output short."],
    };

    const [tool] = collectToolDetails(pi as never, promptOptions);

    const definitionTokens = estimateTokens({
      name: "demo",
      description: "Demo description",
      parameters,
    });
    const promptTokens = estimateTokens([
      "- demo: Perform demo work",
      "- Use demo for demo work.",
      "- Keep demo output short.",
    ].join("\n"));
    expect(tool).toMatchObject({
      definitionTokens,
      promptTokens,
      tokens: definitionTokens + promptTokens,
      active: true,
    });
  });

  it("does not attribute snippets or guidelines omitted by a custom prompt", () => {
    const pi = {
      getActiveTools: () => ["demo"],
      getAllTools: () => [{
        name: "demo",
        description: "Demo",
        parameters: {},
        promptGuidelines: ["Use demo"],
        sourceInfo: {
          path: "/extensions/demo.ts",
          source: "demo-extension",
          scope: "user",
          origin: "top-level",
        },
      }],
    };

    const [tool] = collectToolDetails(pi as never, {
      cwd: "/project",
      customPrompt: "Custom prompt",
      selectedTools: ["demo"],
      toolSnippets: { demo: "Perform demo work" },
      promptGuidelines: ["Use demo"],
    });

    expect(tool?.promptTokens).toBe(0);
    expect(tool?.tokens).toBe(tool?.definitionTokens);
  });

  it("attributes a duplicated prompt guideline to only the first active tool", () => {
    const sourceInfo = {
      path: "/extensions/tools.ts",
      source: "test-extension",
      scope: "user",
      origin: "top-level",
    };
    const pi = {
      getActiveTools: () => ["first", "second"],
      getAllTools: () => [
        { name: "first", description: "", parameters: {}, promptGuidelines: ["Shared rule"], sourceInfo },
        { name: "second", description: "", parameters: {}, promptGuidelines: ["Shared rule"], sourceInfo },
      ],
    };
    const promptOptions = {
      cwd: "/project",
      selectedTools: ["first", "second"],
      promptGuidelines: ["Shared rule", "Shared rule"],
    };

    const tools = collectToolDetails(pi as never, promptOptions);

    expect(tools.find((tool) => tool.name === "first")?.promptTokens).toBe(estimateTokens("- Shared rule"));
    expect(tools.find((tool) => tool.name === "second")?.promptTokens).toBe(0);
  });

  it("attributes prompt wrappers and paths to memory files and skills", () => {
    const promptOptions: BuildSystemPromptOptions = {
      cwd: "/project",
      selectedTools: ["read"],
      contextFiles: [{ path: "AGENTS.md", content: "rules" }],
      skills: [{
        name: "review",
        description: "Review code",
        filePath: "/skills/review/SKILL.md",
        baseDir: "/skills/review",
        disableModelInvocation: false,
        sourceInfo: {
          path: "/skills/review/SKILL.md",
          source: "skills",
          scope: "project",
          origin: "top-level",
        },
      }],
    };

    expect(collectMemoryDetails(promptOptions)).toEqual([{
      path: "AGENTS.md",
      tokens: estimateTokens('<project_instructions path="AGENTS.md">\nrules\n</project_instructions>\n\n'),
    }]);
    expect(collectSkillDetails({} as never, promptOptions)[0]?.descTokens).toBe(estimateTokens([
      "  <skill>",
      "    <name>review</name>",
      "    <description>Review code</description>",
      "    <location>/skills/review/SKILL.md</location>",
      "  </skill>",
    ].join("\n")));
    expect(collectSkillDetails({} as never, { ...promptOptions, selectedTools: [] })).toEqual([]);
    expect(collectMemoryDetails(promptOptions, "replacement prompt")).toEqual([]);
    expect(collectSkillDetails({} as never, promptOptions, "replacement prompt")).toEqual([]);
  });

  it("recognizes built-in tools from Pi provenance metadata", () => {
    const pi = {
      getActiveTools: () => ["read"],
      getAllTools: () => [{
        name: "read",
        description: "Read a file",
        parameters: {},
        sourceInfo: {
          path: "<builtin:read>",
          source: "pi-tools",
          scope: "temporary",
          origin: "top-level",
        },
      }],
    };

    expect(collectToolDetails(pi as never)).toMatchObject([
      { name: "read", source: { kind: "builtin" }, active: true },
    ]);
  });
});
