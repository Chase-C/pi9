import { test } from "vitest";
import assert from "node:assert/strict";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";
import { SubagentOverlayComponent } from "../../src/command/components/overlay.js";
import { fakeAgent, fakeRunSection } from "../helpers/fake-agent.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function overlay(manager: any, initialPage: "sessions" | "agents" | "settings" = "sessions", terminalRows?: number) {
  let renders = 0;
  let closed = false;
  const component = new SubagentOverlayComponent(
    manager,
    {
      requestRender: () => { renders += 1; },
      ...(terminalRows === undefined ? {} : { terminal: { rows: terminalRows } }),
    } as any,
    theme as any,
    undefined,
    () => { closed = true; },
    {
      initialPage,
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume() {},
      onStart() { return undefined; },
      notify() {},
    },
  );
  return { component, get renders() { return renders; }, get closed() { return closed; } };
}

test("narrow rendering keeps the selected logical session row visible", () => {
  const sessions = Array.from({ length: 6 }, (_, index) => fakeAgent({
    id: `session-${index}`,
    prompt: index === 2 ? "▶ misleading task text" : `Task ${index}`,
    status: { kind: "running" },
  }));
  const manager = {
    listSessions: () => sessions,
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager);
  for (let index = 0; index < 5; index++) component.handleInput("\x1b[B");

  const text = component.render(60).join("\n");

  assert.match(text, /┃ .*helper/);
  assert.doesNotMatch(text, /▶.*helper/);
  assert.match(text, /Task 5/);
});

test("session list entries are separated by an empty row", () => {
  const sessions = [
    fakeAgent({ id: "first", prompt: "First task", status: { kind: "running" } }),
    fakeAgent({ id: "second", prompt: "Second task", status: { kind: "running" } }),
  ];
  const manager = {
    listSessions: () => sessions,
    onAgentUpdate: () => () => {},
  };
  const lines = overlay(manager).component.render(120);
  const first = lines.findIndex(line => line.includes("helper first"));
  const second = lines.findIndex(line => line.includes("helper second"));
  const leftPaneWidth = Math.max(30, Math.floor((120 - 2) * 0.4));
  const separator = lines[first + 3]!.slice(1, 1 + leftPaneWidth);

  assert.equal(second - first, 4);
  assert.equal(separator.trim(), "");
});

test("agent definitions arrange identity, tools, and skills across rows", () => {
  const manager = {
    listSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender() {} },
    theme as any,
    undefined,
    () => {},
    {
      initialPage: "agents",
      agents: [
        { name: "helper", description: "Description that belongs only in details", source: "project", model: "gpt-5.6-sol", thinking: "high", skills: ["review"], tools: ["read"], retainConversation: true, systemPrompt: "" },
        { name: "reviewer", description: "Reviews code", source: "user", retainConversation: false, systemPrompt: "" },
      ],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume() {},
      onStart() { return undefined; },
      notify() {},
    },
  );

  const lines = component.render(200);
  const firstAgentLine = lines.find(line => line.includes("helper · gpt-5.6-sol:high") && line.includes("[project]"))!;
  const descriptionLine = lines[lines.indexOf(firstAgentLine) + 1]!;
  const metadataLine = lines[lines.indexOf(firstAgentLine) + 2]!;
  const spacerLine = lines[lines.indexOf(firstAgentLine) + 3]!;
  const leftPaneWidth = Math.max(30, Math.floor((200 - 2) * 0.4));
  const leftPane = (line: string) => line.slice(1, 1 + leftPaneWidth);

  assert.match(firstAgentLine, /┃ helper · gpt-5\.6-sol:high +\[project\]/);
  assert.equal(leftPane(firstAgentLine).trimEnd().endsWith("[project]"), true);
  assert.match(descriptionLine, /Description that belongs only in details/);
  assert.match(metadataLine, /    1 tool · 1 skill · retained/);
  assert.equal(leftPane(spacerLine).trim(), "");
  const purposeLine = lines.find(line => line.includes("┌ helper"))!;
  assert.equal(firstAgentLine.lastIndexOf("helper"), purposeLine.indexOf("┌ helper") + 2);
  assert.equal(purposeLine.indexOf("┌ helper"), leftPaneWidth + 3);

  const reviewerLine = lines.find(line => line.includes("reviewer · default:default") && line.includes("[user]"))!;
  const reviewerSpacer = lines[lines.indexOf(reviewerLine) + 3]!;
  assert.equal(leftPane(reviewerLine).trimEnd().endsWith("[user]"), true);
  assert.equal(leftPane(reviewerSpacer).trim(), "");
});

test("agent descriptions truncate to one line and metadata counts stay muted", () => {
  const manager = {
    listSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const mutedTheme = {
    fg: (color: string, text: string) => color === "dim" ? `\x1b[2m${text}\x1b[22m` : text,
    bold: (text: string) => text,
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender() {} },
    mutedTheme as any,
    undefined,
    () => {},
    {
      initialPage: "agents",
      agents: [{
        name: "helper",
        description: "This list description is intentionally long enough to truncate instead of wrapping onto another row.",
        source: "project",
        retainConversation: false,
        systemPrompt: "Review carefully.",
        tools: ["read", "grep", "find", "bash", "edit", "write", "subagent"],
        skills: ["review", "security-audit", "integration-testing", "performance-analysis"],
      }],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume() {},
      onStart() { return undefined; },
      notify() {},
    },
  );

  const lines = component.render(100);
  const identity = lines.find(line => line.includes("helper") && line.includes("default:default"))!;
  const description = lines.find(line => line.includes("This list description"))!;
  const metadata = lines.find(line => line.includes("7 tools"))!;

  assert.match(identity, /\x1b\[2mdefault:default\x1b\[22m/);
  assert.match(description, /This list description[^\n]*…/);
  assert.match(metadata, /\x1b\[2m    7 tools · 4 skills\x1b\[22m/);
});

test("agent list capacity follows the dynamic pane height", () => {
  const agents = Array.from({ length: 10 }, (_, index) => ({
    name: `agent-${index}`,
    description: `Agent ${index}`,
    source: "project" as const,
    retainConversation: false,
    systemPrompt: "",
  }));
  const manager = {
    listSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender() {}, terminal: { rows: 60 } } as any,
    theme as any,
    undefined,
    () => {},
    {
      initialPage: "agents",
      agents,
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume() {},
      onStart() { return undefined; },
      notify() {},
    },
  );

  const text = component.render(160).join("\n");
  for (const agent of agents) assert.match(text, new RegExp(agent.name));
});

test("agent instructions use the remaining inspector height before truncating", () => {
  const systemPrompt = Array.from({ length: 30 }, (_, index) => `instruction-${index + 1}`).join("\n");
  const manager = {
    listSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const truncationTheme = {
    fg: (color: string, text: string) => color === "muted" ? `\x1b[2m${text}\x1b[22m` : text,
    bold: (text: string) => text,
  };
  const renderAt = (terminalRows: number) => {
    const component = new SubagentOverlayComponent(
      manager as any,
      { requestRender() {}, terminal: { rows: terminalRows } } as any,
      truncationTheme as any,
      undefined,
      () => {},
      {
        initialPage: "agents",
        agents: [{ name: "helper", description: "Reviews code", source: "project", retainConversation: false, systemPrompt }],
        settings: DEFAULT_SUBAGENT_SETTINGS,
        onSettingsChange() {},
        onResume() {},
        onStart() { return undefined; },
        notify() {},
      },
    );
    return component.render(160).join("\n");
  };

  const short = renderAt(30);
  const tall = renderAt(50);
  const omitted = (text: string) => Number(text.match(/… (\d+) more lines/)?.[1] ?? 0);

  assert.match(short, /┌ Instructions/);
  assert.match(short, /instruction-1/);
  assert.match(short, /\x1b\[2m… 29 more lines\x1b\[22m/);
  assert.ok(omitted(short) > omitted(tall));
  assert.match(tall, /instruction-10/);
  assert.match(short, /Start Subagent/);
  assert.match(tall, /Start Subagent/);
});

test("wrapped inspector sections preserve separately muted rails", () => {
  const manager = {
    listSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const railTheme = {
    fg: (color: string, text: string) => color === "muted"
      ? `\x1b[2m${text}\x1b[22m`
      : color === "accent" ? `\x1b[36m${text}\x1b[39m` : text,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender() {}, terminal: { rows: 50 } } as any,
    railTheme as any,
    undefined,
    () => {},
    {
      initialPage: "agents",
      agents: [{
        name: "helper",
        description: "This deliberately long purpose must wrap onto several rows without losing the section rail on continuation lines.",
        source: "project",
        retainConversation: false,
        systemPrompt: "Review carefully.",
      }],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume() {},
      onStart() { return undefined; },
      notify() {},
    },
  );

  const lines = component.render(100);
  const start = lines.findIndex(line => line.includes("helper") && line.includes("┌"));
  const end = lines.findIndex((line, index) => index > start && line.includes("└"));
  const content = lines.slice(start + 1, end);

  assert.match(lines[start]!, /\x1b\[2m┌\x1b\[22m \x1b\[36m\x1b\[1mhelper\x1b\[22m\x1b\[39m/);
  assert.ok(content.length > 1);
  for (const line of content) assert.match(line, /\x1b\[2m│\x1b\[22m/);
});

test("session inspector combines concise metadata with expanded result sections", () => {
  const child = fakeAgent({ id: "child", parentSessionId: "session", label: "nested", status: { kind: "completed", response: "child done" }, toolUses: 1 });
  const session = fakeAgent({
    id: "session",
    label: "auth review",
    prompt: "Review the authentication changes.",
    config: { description: "Redundant description", tools: ["read", "bash"], sourcePath: "/repo/agent.md" },
    status: { kind: "completed", response: "Found one refresh race." },
    message: "Redundant message",
    turns: 3,
    compactions: 1,
    toolUses: 4,
    previousRuns: [fakeRunSection({ prompt: "Review the first version.", status: { kind: "completed", response: "Requested changes." } })],
    subagents: [child],
    capabilities: { canResume: true, canRemove: true },
  });
  const manager = {
    listSessions: () => [session],
    onAgentUpdate: () => () => {},
  };
  const rendered = overlay(manager, "sessions", 60).component.render(160);
  const text = rendered.join("\n");
  const sessionSectionLine = rendered.find(line => line.includes("┌ helper · session"))!;

  assert.equal(sessionSectionLine.indexOf("┌ helper · session"), Math.floor((160 - 2) * 0.4) + 3);
  assert.match(text, /Label: auth review/);
  assert.doesNotMatch(text, /ID: session/);
  assert.match(text, /┌ Task/);
  assert.match(text, /Review the authentication changes/);
  assert.match(text, /Attempt: spawn · dispatch:foreground/);
  assert.match(text, /┌ Activity/);
  assert.match(text, /Elapsed:/);
  assert.match(text, /Previous Run 1/);
  assert.match(text, /Tools · 4 calls/);
  assert.match(text, /Subagents · 1/);
  assert.match(text, /┌ Answer/);
  assert.match(text, /Found one refresh race/);
  assert.doesNotMatch(text, /Redundant description|Redundant message|\/repo\/agent\.md|Tools: read, bash/);
});

test("session rows show bold agent names followed by session IDs", () => {
  const session = fakeAgent({ id: "session-42", config: { name: "helper" }, status: { kind: "running" } });
  const manager = {
    listSessions: () => [session],
    onAgentUpdate: () => () => {},
  };
  const styledTheme = {
    fg: (color: string, text: string) => color === "muted" || color === "dim"
      ? `\x1b[2m${text}\x1b[22m`
      : color === "accent" ? `\x1b[36m${text}\x1b[39m` : text,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender() {} },
    styledTheme as any,
    undefined,
    () => {},
    {
      initialPage: "sessions",
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume() {},
      onStart() { return undefined; },
      notify() {},
    },
  );

  const sessionsText = component.render(120).join("\n");
  assert.match(sessionsText, /\x1b\[1mhelper\x1b\[22m \x1b\[36msession-42\x1b\[39m/);
  assert.match(sessionsText, /\x1b\[36m\x1b\[1mhelper\x1b\[22m · session-42\x1b\[39m/);
  component.handleInput("\t");
  assert.match(component.render(120).join("\n"), /\[ Settings \]/);
});

test("settings uses the same body height as browser panes", () => {
  const manager = {
    listSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const browser = overlay(manager, "agents").component.render(120);
  const settings = overlay(manager, "settings").component.render(120);
  const bodyHeight = (lines: string[]) => lines.findIndex(line => line.startsWith("├")) - 1;

  const browserDivider = browser.findIndex(line => line.startsWith("├"));
  assert.match(browser[0]!, /^╭───\[ Agents \]/);
  assert.match(browser[1]!, /^│ +│$/);
  assert.match(browser[browserDivider - 1]!, /^│  \/ Filter…/);
  assert.equal(bodyHeight(settings), bodyHeight(browser));
  assert.equal(bodyHeight(settings), 24);
  assert.match(settings.join("\n"), /Widget rows/);

  const eightyPercent = overlay(manager, "settings", 50).component.render(120);
  assert.equal(eightyPercent.length, 40);
});

test("agent definition prompts start background sessions", () => {
  const started: Array<{ agent: string; prompt: string }> = [];
  const manager = {
    listSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender() {} },
    theme as any,
    undefined,
    () => {},
    {
      initialPage: "agents",
      agents: [{ name: "helper", description: "Helps", source: "project", retainConversation: false, systemPrompt: "" }],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume() {},
      onStart(agent, prompt) {
        started.push({ agent, prompt });
        return "plain";
      },
      notify() {},
    },
  );

  component.handleInput("\r");
  for (const character of "Implement parser") component.handleInput(character);
  component.handleInput("\r");

  assert.deepEqual(started, [{ agent: "helper", prompt: "Implement parser" }]);
});

test("filtering agents clears a draft owned by the previous selection", () => {
  const manager = {
    listSessions: () => [],
    onAgentUpdate: () => () => {},
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender() {} },
    theme as any,
    undefined,
    () => {},
    {
      initialPage: "agents",
      agents: [
        { name: "helper", description: "Helps", source: "project", retainConversation: false, systemPrompt: "" },
        { name: "reviewer", description: "Reviews", source: "project", retainConversation: false, systemPrompt: "" },
      ],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume() {},
      onStart() { return undefined; },
      notify() {},
    },
  );

  component.handleInput("\r");
  for (const character of "OLD DRAFT") component.handleInput(character);
  component.handleInput("\x1b");
  component.handleInput("/");
  for (const character of "reviewer") component.handleInput(character);

  const rendered = component.render(100).join("\n");
  assert.match(rendered, /reviewer/);
  assert.doesNotMatch(rendered, /OLD DRAFT/);
});

test("filter focus propagates the hardware cursor marker and all narrow lines fit", () => {
  const session = fakeAgent({ id: "long", prompt: "A very long task description ".repeat(20), status: { kind: "running" } });
  const manager = {
    listSessions: () => [session],
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager);
  component.focused = true;
  component.handleInput("/");

  const lines = component.render(60);

  assert.equal(lines.some(line => line.includes(CURSOR_MARKER)), true);
  assert.equal(lines.every(line => visibleWidth(line) <= 60), true);
});

test("disposing the overlay unsubscribes live manager updates", () => {
  let unsubscribed = false;
  const manager = {
    listSessions: () => [],
    onAgentUpdate: () => () => { unsubscribed = true; },
  };
  const { component } = overlay(manager);

  component.dispose();

  assert.equal(unsubscribed, true);
});

test("queued sessions can still be stopped from Sessions", async () => {
  const queued = fakeAgent({ id: "queued", status: { kind: "queued" } });
  const stopped: string[] = [];
  const manager = {
    listSessions: () => [queued],
    stopSession: async (id: string) => { stopped.push(id); },
    onAgentUpdate: () => () => {},
  };
  overlay(manager).component.handleInput("x");
  await Promise.resolve();

  assert.deepEqual(stopped, ["queued"]);
});

test("Enter replaces Sessions with a full-width conversation pane", () => {
  const session = fakeAgent({ id: "running", status: { kind: "running" } });
  const manager = {
    listSessions: () => [session],
    sessionConversation: () => ({
      session,
      messages: [
        { role: "user", text: "Inspect the parser" },
        { role: "assistant", text: "I found **the issue**." },
        { role: "tool", text: "read {\"path\":\"parser.ts\"}", toolName: "read" },
      ],
      pending: { steering: [], followUp: [] },
    }),
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager);

  component.handleInput("\r");
  const text = component.render(120).join("\n");

  assert.match(text, /helper · running · running/);
  assert.match(text, /Inspect the parser/);
  assert.match(text, /I found the issue/);
  assert.match(text, /read .*parser\.ts/);
  assert.doesNotMatch(text, /\[ Sessions \]|\[ Agents \]|Filter/);
});

test("conversation composer messages a running session directly", async () => {
  const session = fakeAgent({ id: "running", status: { kind: "running" }, capabilities: { canResume: false } });
  const messages: Array<[string, string]> = [];
  const manager = {
    listSessions: () => [session],
    sessionConversation: () => ({ session, messages: [], pending: { steering: [], followUp: [] } }),
    steerSession: async (id: string, text: string) => { messages.push([id, text]); },
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager);

  component.handleInput("\r");
  for (const character of "Focus parser") component.handleInput(character);
  component.handleInput("\r");
  await Promise.resolve();

  assert.deepEqual(messages, [["running", "Focus parser"]]);
  assert.match(component.render(100).join("\n"), /helper · running · running/);
});

test("Escape returns from conversation mode to Sessions", () => {
  const session = fakeAgent({ id: "running", status: { kind: "running" } });
  const manager = {
    listSessions: () => [session],
    sessionConversation: () => ({ session, messages: [], pending: { steering: [], followUp: [] } }),
    onAgentUpdate: () => () => {},
  };
  const { component } = overlay(manager);

  component.handleInput("\r");
  component.handleInput("\x1b");

  assert.match(component.render(100).join("\n"), /\[ Sessions \]/);
});

test("completed retained sessions resume through the same conversation pane", () => {
  const session = fakeAgent({ id: "done", retention: "persistent", capabilities: { canResume: true }, status: { kind: "completed" } });
  const resumes: Array<[string, string]> = [];
  const manager = {
    listSessions: () => [session],
    sessionConversation: () => ({ session, messages: [], pending: { steering: [], followUp: [] } }),
    onAgentUpdate: () => () => {},
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender() {} },
    theme as any,
    undefined,
    () => {},
    {
      initialPage: "sessions",
      agents: [],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      onSettingsChange() {},
      onResume: (id, prompt) => resumes.push([id, prompt]),
      onStart() { return undefined; },
      notify() {},
    },
  );

  component.handleInput("\r");
  for (const character of "Follow up") component.handleInput(character);
  component.handleInput("\r");

  assert.deepEqual(resumes, [["done", "Follow up"]]);
});
