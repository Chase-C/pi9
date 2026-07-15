#!/usr/bin/env node

// Terminal mockups for the inline rows below `subagent run`.
// Run with: node packages/subagent/scripts/agent-row-mockups.mjs
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
    turns: 4, tools: 7, tokens: "12.4k", elapsed: "18s", activity: 'grep("renderCall" in src) · 2s',
  },
  {
    status: "running", name: "researcher", label: "Compare other extensions", depth: 1,
    turns: 2, tools: 4, tokens: "8.1k", elapsed: "11s", activity: "web_fetch(github.com/…) · 3s",
  },
  {
    status: "running", name: "reviewer", label: "Review hierarchy and density", depth: 0,
    turns: 3, tools: 5, tokens: "9.7k", elapsed: "14s", activity: "read(src/view/session-lines.ts) · 1s",
  },
  {
    status: "queued", name: "planner", label: "Synthesize a recommendation", depth: 0,
    turns: 0, tools: 0, tokens: "0", elapsed: "6s", activity: "waiting for a slot",
  },
  {
    status: "completed", name: "critic", label: "Check accessibility", depth: 0,
    turns: 5, tools: 6, tokens: "15.2k", elapsed: "22s", activity: "Done",
  },
];

function glyph(agent) {
  if (agent.status === "running") return style.accent("⠹");
  if (agent.status === "queued") return style.muted("○");
  if (agent.status === "completed") return style.success("✓");
  return style.error("✗");
}

function name(agent) {
  return agent.status === "queued" ? style.muted(agent.name) : style.bold(agent.name);
}

function stats(agent, includeTools = false) {
  const parts = [`${agent.turns} turns`];
  if (includeTools) parts.push(`${agent.tools} tools`);
  parts.push(`${agent.tokens} tokens`, agent.elapsed);
  return style.dim(parts.join(" · "));
}

function title() {
  return `${style.title(style.bold("subagent") + " run")}  ${style.dim("3 running · 1 queued · 1 finished · 22s")}`;
}

function option(label, note, render) {
  console.log(`\n${style.bold(label)} ${style.dim(`— ${note}`)}`);
  console.log(title());
  console.log(render(agents).join("\n"));
}

option("A. Compact baseline", "closest to the current renderer", rows => rows.flatMap(agent => {
  const indent = "  ".repeat(agent.depth);
  const row = `${indent}  ${glyph(agent)} ${name(agent)}  ${agent.label} · ${stats(agent)}`;
  return agent.status === "running" ? [row, `${indent}    ${style.dim(agent.activity)}`] : [row];
}));

option("B. Activity subline", "Claude-style scan path; identity above, live work below", rows => rows.flatMap(agent => {
  const indent = "  ".repeat(agent.depth);
  const row = `${indent}  ${glyph(agent)} ${name(agent)}  ${style.dim(agent.label)}  ${stats(agent)}`;
  return agent.status === "running"
    ? [row, `${indent}    ${style.dim("⎿  " + agent.activity)}`]
    : [row, `${indent}    ${style.dim("⎿  " + (agent.status === "queued" ? agent.activity : "Done"))}`];
}));

option("C. Connected tree", "makes nested delegation explicit", rows => rows.flatMap((agent, index) => {
  const nextRoot = rows.slice(index + 1).some(candidate => candidate.depth === 0);
  const branch = agent.depth ? "│  └─" : nextRoot ? "├─" : "└─";
  const row = `  ${style.dim(branch)} ${glyph(agent)} ${name(agent)}  ${agent.label}  ${stats(agent)}`;
  if (agent.status !== "running") return [row];
  const continuation = agent.depth ? "│     " : nextRoot ? "│ " : "  ";
  return [row, `  ${style.dim(continuation + "   ⎿  " + agent.activity)}`];
}));

option("D. Aligned ledger", "highest information density at stable terminal widths", rows => {
  const header = style.dim("    AGENT         TASK                              TURNS  TOOLS  TOKENS  TIME");
  return [header, ...rows.map(agent => {
    const prefix = agent.depth ? "  ↳ " : "    ";
    const agentName = agent.name.padEnd(13);
    const task = agent.label.padEnd(34).slice(0, 34);
    const values = `${String(agent.turns).padStart(5)}  ${String(agent.tools).padStart(5)}  ${agent.tokens.padStart(6)}  ${agent.elapsed.padStart(4)}`;
    return `${prefix}${glyph(agent)} ${agentName} ${task} ${style.dim(values)}`;
  })];
});

option("E. Activity-first", "quietest metadata; emphasizes what is happening now", rows => rows.flatMap(agent => {
  const indent = "  ".repeat(agent.depth);
  const headline = agent.status === "running" ? agent.activity : agent.status === "queued" ? "Waiting" : "Done";
  return [
    `${indent}  ${glyph(agent)} ${headline}`,
    `${indent}    ${name(agent)} · ${style.dim(agent.label + " · " + agent.elapsed)}`,
  ];
}));

console.log(`\n${style.bold("Rounded-corner iterations")}${style.dim(" — variations on B and C")}`);

option("F. Rounded activity", "B with a softer activity marker", rows => rows.flatMap(agent => {
  const indent = "  ".repeat(agent.depth);
  const row = `${indent}  ${glyph(agent)} ${name(agent)}  ${style.dim(agent.label)}  ${stats(agent)}`;
  const activity = agent.status === "running" ? agent.activity : agent.status === "queued" ? agent.activity : "Done";
  return [row, `${indent}    ${style.dim("╰ " + activity)}`];
}));

option("G. Nested branches only", "root agents stay light; nested agents connect to their parent", rows => rows.flatMap(agent => {
  const nested = agent.depth > 0;
  const prefix = nested ? "    " + style.dim("╰─") + " " : "  ";
  const row = `${prefix}${glyph(agent)} ${name(agent)}  ${style.dim(agent.label)}  ${stats(agent)}`;
  const activity = agent.status === "running" ? agent.activity : agent.status === "queued" ? agent.activity : "Done";
  const activityIndent = nested ? "         " : "    ";
  return [row, `${activityIndent}${style.dim("╰ " + activity)}`];
}));

option("H. Parent rail", "a short rail appears only when an agent has nested work", rows => {
  const lines = [];
  for (let index = 0; index < rows.length; index++) {
    const agent = rows[index];
    const nested = agent.depth > 0;
    const hasNestedChild = !nested && rows[index + 1]?.depth > agent.depth;
    const prefix = nested ? "  " + style.dim("╰─") + " " : "  ";
    lines.push(`${prefix}${glyph(agent)} ${name(agent)}  ${style.dim(agent.label)}  ${stats(agent)}`);
    const activity = agent.status === "running" ? agent.activity : agent.status === "queued" ? agent.activity : "Done";
    if (nested) lines.push(`      ${style.dim("╰ " + activity)}`);
    else if (hasNestedChild) lines.push(`  ${style.dim("│")}   ${style.dim("╰ " + activity)}`);
    else lines.push(`    ${style.dim("╰ " + activity)}`);
  }
  return lines;
});

option("I. Nested arrow", "rounded activity plus an unambiguous parent-child cue", rows => rows.flatMap(agent => {
  const nested = agent.depth > 0;
  const prefix = nested ? `    ${style.dim("↳")} ` : "  ";
  const row = `${prefix}${glyph(agent)} ${name(agent)}  ${style.dim(agent.label)}  ${stats(agent)}`;
  const activity = agent.status === "running" ? agent.activity : agent.status === "queued" ? agent.activity : "Done";
  const activityIndent = nested ? "        " : "    ";
  return [row, `${activityIndent}${style.dim("╰ " + activity)}`];
}));

console.log(`\n${style.dim("Tip: compare both density and how quickly your eye can find the active tool.")}\n`);
