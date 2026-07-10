import { describe, expect, it, vi } from "vitest";
import contextExtension from "../src/index.js";

describe("context command", () => {
  it("does not open terminal UI outside TUI mode", async () => {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
      getThinkingLevel: () => "off",
      getActiveTools: () => [],
      getAllTools: () => [],
    };
    const custom = vi.fn();
    const notify = vi.fn();
    const ctx = {
      mode: "rpc",
      hasUI: true,
      cwd: "/project",
      isProjectTrusted: () => false,
      ui: { custom, notify },
      model: { provider: "test", id: "model", name: "Model", contextWindow: 10_000 },
      getContextUsage: () => ({ contextWindow: 10_000, tokens: 100, percent: 1 }),
      getSystemPrompt: () => "prompt",
      getSystemPromptOptions: () => ({ cwd: "/project", skills: [], contextFiles: [] }),
      sessionManager: { getBranch: () => [] },
    };

    contextExtension(pi as never);
    await handler?.("", ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("/context requires interactive mode", "warning");
  });
});
