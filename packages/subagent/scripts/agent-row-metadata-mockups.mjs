#!/usr/bin/env node

// Same-line metadata mockups using the selected "parent rail" layout.
// Run with: node packages/subagent/scripts/agent-row-metadata-mockups.mjs
// Add --plain to disable ANSI styling.

const color = process.stdout.isTTY && !process.argv.includes("--plain") && !process.env.NO_COLOR;
const ansi = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
const style = {
  bold: text => ansi("1", text),
  dim: text => ansi("2", text),
  accent: text => ansi("36", text),
  success: text => ansi("32", text),
  error: text => ansi("31", text),
  muted: text => ansi("90", text),
  title: text => ansi("35", text),
};

const agents = [
  {
    status: "running", name: "scout", label: "Find rendering patterns", depth: 0,
    turns: 5, toolCalls: 12, tokens: "18.6k", elapsed: "31s",
    recentTools: ["read(src/view/session-lines.ts) · 1s", 'grep("formatRunSessionLine" in src) · 2s', "subagent(run 1 task) · 9s"],
  },
  {
    status: "running", name: "researcher", label: "Compare other extensions", depth: 1,
    turns: 2, toolCalls: 1, tokens: "8.1k", elapsed: "11s",
    recentTools: ["web_fetch(github.com/…) · 3s"],
  },
  {
    status: "running", name: "reviewer", label: "Review hierarchy and density", depth: 0,
    turns: 3, toolCalls: 3, tokens: "9.7k", elapsed: "14s",
    recentTools: ["read(src/view/session-lines.ts) · 1s", 'grep("renderCall" in src) · 2s', "read(src/view/tool-result-lines.ts) · 1s"],
  },
  {
    status: "queued", name: "planner", label: "Synthesize a recommendation", depth: 0,
    turns: 0, toolCalls: 0, tokens: "0", elapsed: "6s", recentTools: [],
  },
  {
    status: "completed", name: "critic", label: "Check accessibility", depth: 0,
    turns: 9, toolCalls: 48, tokens: "42.3k", elapsed: "1m22s", recentTools: [],
  },
];

function glyph(agent) {
  if (agent.status === "running") return style.accent("⠹");
  if (agent.status === "queued") return style.muted("○");
  if (agent.status === "completed") return style.success("✓");
  return style.error("✗");
}

function agentName(agent) {
  return agent.status === "queued" ? style.muted(agent.name) : style.bold(agent.name);
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function title() {
  return `${style.title(style.bold("subagent") + " run")}  ${style.dim("3 running · 1 queued · 1 finished · 1m22s")}`;
}

function metadataOption(label, note, formatMetadata) {
  console.log(`\n${style.bold(label)} ${style.dim(`— ${note}`)}`);
  console.log(title());
  const lines = [];
  for (let index = 0; index < agents.length; index++) {
    const agent = agents[index];
    const nested = agent.depth > 0;
    const hasNestedChild = !nested && agents[index + 1]?.depth > agent.depth;
    const prefix = nested ? `  ${style.dim("╰─")} ` : "  ";
    const metadata = formatMetadata(agent);
    lines.push(`${prefix}${glyph(agent)} ${agentName(agent)}  ${style.dim(agent.label)}${metadata ? `  ${style.dim(metadata)}` : ""}`);

    if (agent.status !== "running" || agent.recentTools.length === 0) continue;
    const activity = agent.recentTools.at(-1);
    if (nested) lines.push(`      ${style.dim("╰ " + activity)}`);
    else if (hasNestedChild) lines.push(`  ${style.dim("│")}   ${style.dim("╰ " + activity)}`);
    else lines.push(`    ${style.dim("╰ " + activity)}`);
  }
  console.log(lines.join("\n"));
}

metadataOption("A. Full telemetry", "everything currently available on the row", agent => [
  plural(agent.turns, "turn"),
  plural(agent.toolCalls, "tool call"),
  `${agent.tokens} tokens`,
  agent.elapsed,
].join(" · "));

metadataOption("B. Tool-forward", "tool-call count and elapsed time get priority", agent => [
  plural(agent.toolCalls, "tool call"),
  agent.elapsed,
].join(" · "));

metadataOption("C. Work + scale", "drops turns but keeps tools, tokens, and time", agent => [
  plural(agent.toolCalls, "tool call"),
  `${agent.tokens} tokens`,
  agent.elapsed,
].join(" · "));

metadataOption("D. Agent loop", "turns and tool calls describe behavior; elapsed closes the row", agent => [
  plural(agent.turns, "turn"),
  plural(agent.toolCalls, "tool call"),
  agent.elapsed,
].join(" · "));

metadataOption("E. Compact notation", "same information with shorter labels", agent => [
  `${agent.turns}t`,
  plural(agent.toolCalls, "tool"),
  agent.tokens,
  agent.elapsed,
].join(" · "));

console.log(`\n${style.bold("Collapsed tool-history constraints")}${style.dim(" — current behavior, with variable call counts")}`);
console.log(title());

const historyCases = [
  { name: "thinker", calls: [], status: "running", elapsed: "8s" },
  { name: "reader", calls: ["read(src/index.ts) · 1s"], status: "running", elapsed: "9s" },
  { name: "investigator", calls: ["read(src/a.ts) · 1s", "grep(auth in src) · 2s", "read(src/b.ts) · 1s"], status: "running", elapsed: "18s" },
  { name: "worker", calls: ["read(src/a.ts) · 1s", "grep(auth in src) · 2s", "read(src/b.ts) · 1s", "edit(src/b.ts) · 3s", "bash(npm test) · 6s", "read(test.log) · 1s"], status: "running", elapsed: "34s" },
  { name: "finished", calls: new Array(9).fill("tool"), status: "completed", elapsed: "52s" },
];

for (const item of historyCases) {
  const fakeAgent = { ...item, toolCalls: item.calls.length };
  console.log(`  ${glyph(fakeAgent)} ${style.bold(item.name)}  ${style.dim(`${plural(item.calls.length, "tool call")} · ${item.elapsed}`)}`);
  if (item.status !== "running") continue; // Terminal rows collapse all tool history.
  const recent = item.calls.slice(-3).reverse(); // Newest first, capped at three.
  for (const tool of recent) console.log(`    ${style.dim("╰ " + tool)}`);
  const additional = item.calls.length - recent.length;
  if (additional > 0) console.log(`    ${style.dim(`+${additional} additional ${additional === 1 ? "tool call" : "tool calls"}`)}`);
}

console.log(`\n${style.dim("The nested scout row also reflects the current rule that an active nested subagent call takes precedence over the parent’s other recent tools.")}\n`);
