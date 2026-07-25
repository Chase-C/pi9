import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => mocks.agentDir,
}));

import personaExtension from "../src/index.js";

interface PersonaToolParams {
  action: "list" | "set" | "clear";
  persona?: string;
}

interface Harness {
  appendEntry: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  command: { handler: (args: string, ctx: TestContext) => Promise<void> };
  events: Record<string, (event: Record<string, unknown>, ctx: TestContext) => unknown>;
  shortcuts: Record<string, (ctx: TestContext) => Promise<void>>;
  tool: {
    execute: (
      toolCallId: string,
      params: PersonaToolParams,
      signal: undefined,
      onUpdate: undefined,
      ctx: TestContext,
    ) => Promise<unknown>;
  };
}

interface TestContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted: () => boolean;
  sessionManager: { getBranch: () => unknown[]; buildContextEntries: () => unknown[] };
  ui: {
    notify: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    theme: { fg: (_color: string, text: string) => string };
  };
}

function createHarness(): Harness {
  const events: Harness["events"] = {};
  const shortcuts: Harness["shortcuts"] = {};
  let command: Harness["command"] | undefined;
  let tool: Harness["tool"] | undefined;
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const pi = {
    registerCommand: (_name: string, registered: Harness["command"]) => {
      command = registered;
    },
    registerTool: (registered: Harness["tool"]) => {
      tool = registered;
    },
    registerShortcut: (key: string, registered: { handler: Harness["shortcuts"][string] }) => {
      shortcuts[key] = registered.handler;
    },
    on: (name: string, handler: Harness["events"][string]) => {
      events[name] = handler;
    },
    appendEntry,
    sendMessage,
  };

  personaExtension(pi as never);
  if (!command) throw new Error("Persona command was not registered");
  if (!tool) throw new Error("Persona tool was not registered");
  return { appendEntry, sendMessage, command, events, shortcuts, tool };
}

function createContext(
  branch: unknown[] = [],
  options: { cwd?: string; trusted?: boolean; contextEntries?: unknown[] } = {},
): TestContext {
  return {
    cwd: options.cwd ?? "/project",
    hasUI: true,
    isProjectTrusted: () => options.trusted ?? false,
    sessionManager: {
      getBranch: () => branch,
      buildContextEntries: () => options.contextEntries ?? branch,
    },
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_color, text) => text },
    },
  };
}

beforeEach(() => {
  mocks.agentDir = mkdtempSync(join(tmpdir(), "pi9-persona-agent-"));
  mkdirSync(join(mocks.agentDir, "personas"));
  writeFileSync(
    join(mocks.agentDir, "personas", "planner.md"),
    "---\nname: planner\ndescription: Plan before implementation\n---\n\nExplore first and return a numbered implementation plan.",
  );
  writeFileSync(
    join(mocks.agentDir, "personas", "reviewer.md"),
    "---\nname: reviewer\n---\n\nReview for correctness and regressions.",
  );
});

describe("persona extension", () => {
  it("leaves the system prompt untouched when the first turn has no active persona", () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.events.session_start({}, ctx);

    expect(harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx)).toBeUndefined();
  });

  it("uses two system-prompt sections when a persona is selected before the first turn", async () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.events.session_start({}, ctx);

    await harness.command.handler("planner", ctx);
    const result = harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx);

    expect(harness.appendEntry).toHaveBeenCalledWith("persona-state", {
      activeName: "planner",
      baselineName: "planner",
    });
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("## Persona baseline: planner"),
    });
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("persona", "persona:planner");
  });

  it("injects a hidden activation without modifying the system prompt after a no-persona start", async () => {
    const branch = [{ type: "message", message: { role: "user", content: "Hello" } }];
    const harness = createHarness();
    const ctx = createContext(branch);
    harness.events.session_start({}, ctx);

    await harness.command.handler("reviewer", ctx);
    const result = harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx);

    expect(harness.appendEntry).toHaveBeenCalledWith("persona-state", {
      activeName: "reviewer",
      baselineName: null,
    });
    expect(result).toBeUndefined();
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "persona-activation",
        details: { name: "reviewer" },
      }),
    );
  });

  it("sends a late activation synchronously instead of returning it from the hook", async () => {
    const branch = [{ type: "message", message: { role: "user", content: "Hello" } }];
    const harness = createHarness();
    const ctx = createContext(branch);
    harness.events.session_start({}, ctx);
    await harness.command.handler("reviewer", ctx);

    let hookReturned = false;
    harness.sendMessage.mockImplementation(() => {
      expect(hookReturned).toBe(false);
    });

    const result = harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx);
    hookReturned = true;

    expect(result).toBeUndefined();
    expect(harness.sendMessage).toHaveBeenCalledOnce();
  });

  it("restores the prompt baseline and communicates a later clear", async () => {
    const harness = createHarness();
    const ctx = createContext([
      {
        type: "custom",
        customType: "persona-state",
        data: { activeName: "planner", baselineName: "planner" },
      },
      { type: "message", message: { role: "user", content: "Start" } },
    ]);
    harness.events.session_start({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("persona", "persona:planner");

    await harness.command.handler("none", ctx);
    const result = harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx);

    expect(harness.appendEntry).toHaveBeenLastCalledWith("persona-state", {
      activeName: null,
      baselineName: "planner",
    });
    expect(result).toEqual({
      systemPrompt: expect.stringContaining("## Persona baseline: planner"),
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "persona-change",
        details: { name: null },
      }),
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("persona", undefined);
  });

  it("does not repeat a persona change already present on the current branch", () => {
    const harness = createHarness();
    const ctx = createContext([
      {
        type: "custom",
        customType: "persona-state",
        data: { activeName: "reviewer", baselineName: "planner" },
      },
      {
        type: "custom_message",
        customType: "persona-change",
        details: { name: "reviewer" },
      },
    ]);
    harness.events.session_start({}, ctx);

    const result = harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx);

    expect(result).toEqual({
      systemPrompt: expect.stringContaining("## Persona baseline: planner"),
    });
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it("promotes the active persona to the system-prompt baseline after compaction", async () => {
    const branch: unknown[] = [];
    const harness = createHarness();
    const ctx = createContext(branch);
    harness.events.session_start({}, ctx);

    await harness.command.handler("planner", ctx);
    branch.push({ type: "message", message: { role: "user", content: "Start" } });
    await harness.command.handler("reviewer", ctx);
    harness.events.session_compact({}, ctx);

    expect(harness.appendEntry).toHaveBeenLastCalledWith("persona-state", {
      activeName: "reviewer",
      baselineName: "reviewer",
    });
    expect(harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx)).toEqual({
      systemPrompt: expect.stringContaining("## Persona baseline: reviewer"),
    });

    await harness.command.handler("planner", ctx);
    expect(harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx)).toEqual({
      systemPrompt: expect.stringContaining("## Persona baseline: reviewer"),
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "persona-change",
        details: { name: "planner" },
      }),
    );
  });

  it("removes persona prompt additions when compaction occurs while cleared", async () => {
    const branch: unknown[] = [];
    const harness = createHarness();
    const ctx = createContext(branch);
    harness.events.session_start({}, ctx);

    await harness.command.handler("planner", ctx);
    branch.push({ type: "message", message: { role: "user", content: "Start" } });
    await harness.command.handler("none", ctx);
    harness.events.session_compact({}, ctx);

    expect(harness.appendEntry).toHaveBeenLastCalledWith("persona-state", {
      activeName: null,
      baselineName: null,
    });
    expect(harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx)).toBeUndefined();
  });

  it("cycles alphabetically in both directions with Alt+bracket shortcuts", async () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.events.session_start({}, ctx);

    await harness.shortcuts["alt+]"](ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("persona", "persona:planner");

    await harness.shortcuts["alt+]"](ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("persona", "persona:reviewer");

    await harness.shortcuts["alt+["](ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("persona", "persona:planner");
  });

  it("uses activation for the first late cycle and change for the next cycle", async () => {
    const branch: unknown[] = [
      { type: "message", message: { role: "user", content: "Start without a persona" } },
    ];
    const harness = createHarness();
    const ctx = createContext(branch);
    harness.events.session_start({}, ctx);

    await harness.shortcuts["alt+]"](ctx);
    expect(harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx)).toBeUndefined();
    expect(harness.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "persona-activation",
        details: { name: "planner" },
      }),
    );

    branch.push({
      type: "custom_message",
      customType: "persona-activation",
      details: { name: "planner" },
    });
    await harness.shortcuts["alt+]"](ctx);
    expect(harness.events.before_agent_start({ systemPrompt: "Base prompt" }, ctx)).toBeUndefined();
    expect(harness.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "persona-change",
        details: { name: "reviewer" },
      }),
    );
  });

  it("lists configured personas and the active selection through the tool", async () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.events.session_start({}, ctx);
    await harness.command.handler("planner", ctx);

    const result = await harness.tool.execute("tool-call", { action: "list" }, undefined, undefined, ctx);

    expect(result).toMatchObject({
      content: [{
        type: "text",
        text: expect.stringContaining(
          "Active persona: planner\n\nAvailable personas:\n- planner — Plan before implementation\n- reviewer",
        ),
      }],
      details: { action: "list", activeName: "planner" },
    });
  });

  it("sets a persona through the tool and communicates it during the current run", async () => {
    const branch = [{ type: "message", message: { role: "user", content: "Switch personas" } }];
    const harness = createHarness();
    const ctx = createContext(branch);
    harness.events.session_start({}, ctx);

    const result = await harness.tool.execute(
      "tool-call",
      { action: "set", persona: "reviewer" },
      undefined,
      undefined,
      ctx,
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: 'Persona changed to "reviewer".' }],
      details: { action: "set", activeName: "reviewer" },
    });
    expect(harness.appendEntry).toHaveBeenLastCalledWith("persona-state", {
      activeName: "reviewer",
      baselineName: null,
    });
    expect(harness.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "persona-activation",
        details: { name: "reviewer" },
      }),
    );
  });

  it("clears a persona through the tool and rejects invalid action arguments", async () => {
    const branch = [
      {
        type: "custom",
        customType: "persona-state",
        data: { activeName: "planner", baselineName: "planner" },
      },
      {
        type: "custom_message",
        customType: "persona-change",
        details: { name: "planner" },
      },
    ];
    const harness = createHarness();
    const ctx = createContext(branch);
    harness.events.session_start({}, ctx);

    const result = await harness.tool.execute("tool-call", { action: "clear" }, undefined, undefined, ctx);

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Persona cleared." }],
      details: { action: "clear", activeName: null },
    });
    expect(harness.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "persona-change",
        details: { name: null },
      }),
    );
    await expect(harness.tool.execute(
      "tool-call",
      { action: "set" },
      undefined,
      undefined,
      ctx,
    )).rejects.toThrow('persona is required when action is "set"');
    await expect(harness.tool.execute(
      "tool-call",
      { action: "list", persona: "planner" },
      undefined,
      undefined,
      ctx,
    )).rejects.toThrow('persona must not be provided when action is "list"');
  });

  it("rejects unknown personas through the tool", async () => {
    const harness = createHarness();
    const ctx = createContext();
    harness.events.session_start({}, ctx);

    await expect(harness.tool.execute(
      "tool-call",
      { action: "set", persona: "missing" },
      undefined,
      undefined,
      ctx,
    )).rejects.toThrow('Unknown persona "missing". Available: planner, reviewer');
  });

  it("uses project overrides only for trusted projects", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi9-persona-project-"));
    mkdirSync(join(project, ".pi", "personas"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "personas", "planner.md"),
      "---\nname: planner\n---\n\nProject planner",
    );

    const trustedHarness = createHarness();
    const trustedContext = createContext([], { cwd: project, trusted: true });
    trustedHarness.events.session_start({}, trustedContext);
    await trustedHarness.command.handler("planner", trustedContext);
    expect(trustedHarness.events.before_agent_start({ systemPrompt: "Base" }, trustedContext)).toMatchObject({
      systemPrompt: expect.stringContaining("## Persona baseline: planner\n\nProject planner"),
    });

    const untrustedHarness = createHarness();
    const untrustedContext = createContext([], { cwd: project, trusted: false });
    untrustedHarness.events.session_start({}, untrustedContext);
    await untrustedHarness.command.handler("planner", untrustedContext);
    expect(untrustedHarness.events.before_agent_start({ systemPrompt: "Base" }, untrustedContext)).toMatchObject({
      systemPrompt: expect.stringContaining(
        "## Persona baseline: planner\n\nExplore first and return a numbered implementation plan.",
      ),
    });
  });
});
