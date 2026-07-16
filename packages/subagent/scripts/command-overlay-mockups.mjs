#!/usr/bin/env node

const argv = process.argv.slice(2);
const args = new Set(argv);
const plain = args.has("--plain");
const requestedLayout = option("--layout");
const requestedPage = option("--page");
const WIDTH = 118;

const ansi = (code, text) => plain ? text : `\x1b[${code}m${text}\x1b[0m`;
const style = {
  title: text => ansi("1;94", text),
  accent: text => ansi("94", text),
  selected: text => ansi("1;96", text),
  success: text => ansi("92", text),
  warning: text => ansi("93", text),
  error: text => ansi("91", text),
  muted: text => ansi("90", text),
  bold: text => ansi("1", text),
};

const pages = ["sessions", "agents", "attach"];
const layouts = [
  { name: "Sidebar list", note: "Persistent navigation and a spacious focused list", render: sidebarList },
  { name: "Sidebar tri-pane", note: "Navigation, compact results, and inspector all stay visible", render: sidebarTriPane },
  { name: "Balanced master-detail", note: "Top-level tabs with an even browser and inspector split", render: balancedMasterDetail },
  { name: "Hierarchical master-detail", note: "Tree-aware navigation for recursive sessions and grouped agents", render: hierarchicalMasterDetail },
  { name: "Compact rail + inspector", note: "A narrow persistent rail with stacked list and detail regions", render: compactRailInspector },
];

if (args.has("--help")) {
  console.log("Usage: node packages/subagent/scripts/command-overlay-mockups.mjs [--plain] [--layout=1..5] [--page=sessions|agents|attach]");
  process.exit(0);
}

const selectedLayouts = requestedLayout
  ? layouts.filter((_, index) => String(index + 1) === requestedLayout)
  : layouts;
const selectedPages = requestedPage ? pages.filter(page => page === requestedPage) : pages;
if (!selectedLayouts.length || !selectedPages.length) {
  console.error("Unknown layout or page. Use --help for available values.");
  process.exit(1);
}

for (const layout of selectedLayouts) {
  const number = layouts.indexOf(layout) + 1;
  for (const page of selectedPages) {
    console.log(`\n${style.title(`${number}. ${layout.name}`)} ${style.muted(`— ${layout.note} — ${pageName(page)}`)}`);
    console.log(layout.render(page).join("\n"));
  }
}

function option(name) {
  const prefix = `${name}=`;
  return argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

function pageName(page) {
  return page === "sessions" ? "Sessions" : page === "agents" ? "Agent Definitions" : "Attached Live / Resume";
}

function visible(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncate(text, width) {
  if (visible(text).length <= width) return text;
  if (width < 2) return "…".slice(0, width);
  let output = "";
  let count = 0;
  for (let i = 0; i < text.length && count < width - 1;) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      if (end >= 0) {
        output += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    output += text[i++];
    count++;
  }
  return `${output}…${plain ? "" : "\x1b[0m"}`;
}

function pad(text, width) {
  const fitted = truncate(text, width);
  return fitted + " ".repeat(Math.max(0, width - visible(fitted).length));
}

function frame(title, lines, footer) {
  const inner = WIDTH - 2;
  const label = ` ${title} `;
  const output = [`╭${label}${"─".repeat(inner - visible(label).length)}╮`];
  for (const line of lines) output.push(`│${pad(line, inner)}│`);
  if (footer) {
    output.push(`├${"─".repeat(inner)}┤`);
    output.push(`│${pad(` ${footer}`, inner)}│`);
  }
  output.push(`╰${"─".repeat(inner)}╯`);
  return output;
}

function columns(left, leftWidth, right, rightWidth, gutter = " │ ") {
  const count = Math.max(left.length, right.length);
  return Array.from({ length: count }, (_, index) =>
    `${pad(left[index] ?? "", leftWidth)}${style.muted(gutter)}${pad(right[index] ?? "", rightWidth)}`
  );
}

function rule(width, char = "─") {
  return style.muted(char.repeat(width));
}

function tabs(active) {
  return ["Sessions", "Agents", "Attached", "Settings"]
    .map(tab => tab.toLowerCase() === active ? style.selected(`[ ${tab} ]`) : style.muted(`  ${tab}  `))
    .join(" ");
}

function filter(value = "", hint = "type to filter") {
  return `${style.muted("⌕ Filter")}  ${style.selected(value || hint)}${value ? "" : style.muted("_")}`;
}

function glyph(status) {
  if (status === "running") return style.accent("●");
  if (status === "completed") return style.success("✓");
  if (status === "error") return style.error("✗");
  return style.muted("○");
}

function sidebar(page, counts = true) {
  return [
    style.title(" SUBAGENTS"),
    "",
    page === "sessions" ? style.selected(" ▸ Sessions      6") : "   Sessions      6",
    page === "agents" ? style.selected(" ▸ Agents        8") : "   Agents        8",
    page === "attach" ? style.selected(" ▸ Attached      1") : "   Attached      1",
    "   Settings",
    "",
    style.muted(" ───────────────"),
    ...(counts ? [style.muted(" Running        2"), style.muted(" Waiting        1"), style.muted(" Ready          3")] : []),
    "",
    style.muted(" esc close"),
  ];
}

function sessionRows(selectedPrefix = "▌") {
  return [
    `${style.selected(selectedPrefix)} ${glyph("running")} ${style.bold("reviewer")}  Authorization boundary review             ${style.muted("1m42s · 12.8k")}`,
    `    Tracing why refresh tokens survive organization role downgrades.`,
    `    ${style.accent("grep(sessionVersion in src/auth)")}  ${style.muted("· 7 calls · 1 child")}`,
    "",
    `  ${glyph("running")} ${style.bold("tester")}  Cross-tenant regression coverage             ${style.muted("38s · 6.2k")}`,
    `    Adding deletion and membership tests for tenant isolation.`,
    `    ${style.accent("bash(npm test -- auth)")}  ${style.muted("· child of reviewer")}`,
    "",
    `  ${glyph("completed")} ${style.bold("scout")}  Authentication entry-point map              ${style.muted("done · 4.1k")}`,
    `    Located session creation, refresh, and invalidation paths.`,
  ];
}

function agentRows(selectedPrefix = "▌") {
  return [
    `${style.selected(selectedPrefix + " reviewer")}  ${style.muted("project · sonnet-4 · resumable")}`,
    `  Find correctness risks and return evidence with file references.`,
    `  ${style.muted("read, grep, bash · review skill · high thinking")}`,
    "",
    `  ${style.bold("worker")}  ${style.muted("project · sonnet-4 · resumable")}`,
    `  Implement focused changes, run relevant tests, and report verification.`,
    `  ${style.muted("read, edit, write, bash · medium thinking")}`,
    "",
    `  ${style.bold("security-reviewer")}  ${style.muted("user · opus-4.1 · one-shot")}`,
    `  Audit trust boundaries, authorization checks, and unsafe data handling.`,
  ];
}

function attachedConversation(width = 93, completed = false) {
  return [
    `${glyph(completed ? "completed" : "running")} ${style.bold("reviewer / Authorization boundary review")}  ${completed ? style.success("completed") : style.accent("running")}  ${style.muted(completed ? "2m11s · 18.4k" : "1m42s · 12.8k")}`,
    style.muted(completed
      ? "Retained session · sending below starts a resumed attempt in the same conversation."
      : "Attached live · responses and tool events stream into this view."),
    rule(width),
    `${style.muted("YOU")}  Review refresh-token invalidation after role changes.`,
    "",
    `${style.accent("REVIEWER")}  I found the invalidation hook and traced every role mutation.`,
    "",
    `${style.muted("┌ tool · grep")}  ${style.muted("completed in 2s")}`,
    `${style.muted("│")} sessionVersion|invalidateSessions in src/auth and src/routes`,
    `${style.muted("└")} ${style.success("18 matches")}`,
    "",
    `${style.accent("REVIEWER")}  Two admin paths update roles directly; their focused tests are missing.`,
    "",
    `${style.muted(completed ? "┌ Resume this session" : "┌ Steering message")}`,
    `${style.muted("│")} ${style.selected(completed
      ? "Implement the shared invalidation helper and run focused tests._"
      : "Also check whether organization removal clears active sessions._")}`,
    `${style.muted("└")} ${style.muted(completed ? "enter resume · shift+enter newline" : "enter steer · alt+enter follow-up · shift+enter newline")}`,
  ];
}

// 1: persistent sidebar and a spacious single content pane.
function sidebarList(page) {
  const body = page === "sessions"
    ? [style.bold("Sessions"), filter("auth"), rule(93), ...sessionRows(), "", style.muted("3 of 6 match · enter inspect · a attach · r resume · x remove")]
    : page === "agents"
      ? [style.bold("Agent definitions"), filter("review"), rule(93), ...agentRows(), "", style.muted("3 of 8 match · enter inspect · c copy name")]
      : attachedConversation(93);
  return frame("Subagent workspace", columns(sidebar(page), 20, body, 93), "↑↓ navigate · / filter · enter open · tab section · esc close");
}

// 2: sidebar plus compact list plus persistent detail.
function sidebarTriPane(page) {
  const nav = sidebar(page, false);
  const [list, detail] = page === "sessions"
    ? [triSessionList(), sessionInspector(61)]
    : page === "agents"
      ? [triAgentList(), agentInspector()]
      : [triSessionTree(), attachInspector(61)];
  const browser = columns(list, 31, detail, 61);
  return frame("Subagent workspace", columns(nav, 18, browser, 95), "↑↓ select · / filter · enter inspect · a attach · tab section · esc close");
}

function triSessionList() {
  return [
    style.bold("Sessions"),
    filter("tenant"),
    rule(31),
    style.selected("● Authorization review"),
    style.selected("  reviewer · 1m42s · 12.8k"),
    "",
    "● Tenant regression tests",
    style.muted("  tester · 38s · 6.2k"),
    "",
    "✓ Auth entry-point map",
    style.muted("  scout · done · 4.1k"),
    "",
    style.muted("3 of 6 sessions"),
  ];
}

function triAgentList() {
  return [
    style.bold("Agent definitions"),
    filter(""),
    rule(31),
    style.selected("reviewer"),
    style.muted("  project · resumable"),
    "",
    "worker",
    style.muted("  project · resumable"),
    "",
    "scout",
    style.muted("  user · one-shot"),
    "",
    "security-reviewer",
    style.muted("  user · one-shot"),
  ];
}

function triSessionTree() {
  return [
    style.bold("Session tree"),
    filter(""),
    rule(31),
    style.selected("● reviewer"),
    style.selected("  Authorization review"),
    "  ├─ ● tester",
    style.muted("  │    Tenant regressions"),
    "  └─ ✓ scout",
    style.muted("       Auth entry points"),
    "",
    "○ reviewer",
    style.muted("  Cancellation audit"),
  ];
}

function sessionInspector(width) {
  return [
    `${glyph("running")} ${style.bold("Authorization boundary review")}`,
    style.muted("reviewer · bold-mouse · foreground · resumable"),
    rule(width),
    style.bold("Current task"),
    "Trace why refresh tokens survive role downgrades.",
    "",
    style.bold("Now"),
    `${style.accent("grep")} sessionVersion in src/auth  ${style.muted("· 2s")}`,
    style.muted("3 turns · 7 tools · 12.8k tokens · $0.041"),
    "",
    style.bold("Children"),
    `${glyph("running")} tester  Cross-tenant regression coverage  ${style.muted("38s")}`,
    "",
    `${style.selected("[ Attach ]")}  [ Steer ]  [ Stop ]`,
  ];
}

function agentInspector() {
  return [
    `${style.bold("reviewer")}  ${style.muted("project definition")}`,
    "Find correctness risks and return file-backed evidence.",
    rule(61),
    `${style.muted("MODEL")}       anthropic/claude-sonnet-4`,
    `${style.muted("THINKING")}    high`,
    `${style.muted("TOOLS")}       read, grep, bash`,
    `${style.muted("SKILLS")}      review`,
    `${style.muted("RESUMABLE")}   yes`,
    "",
    style.bold("Best for"),
    "Pre-merge reviews, regressions, and correctness checks.",
    "",
    `${style.selected("[ Copy name ]")}  [ Open source ]`,
  ];
}

function attachInspector(width) {
  return [
    `${glyph("running")} ${style.bold("reviewer")}  ${style.muted("attached live · 1m42s")}`,
    rule(width),
    `${style.muted("task")}  Review refresh-token invalidation after role changes.`,
    "",
    `${style.accent("note")}  Found the invalidation hook; tracing role mutations.`,
    `${style.muted("tool")}  grep(sessionVersion)  ${style.success("18 matches")}`,
    `${style.muted("tool")}  read(admin/users.ts)  ${style.success("done")}`,
    `${style.accent("note")}  Two admin paths update roles directly.`,
    `${style.muted("tool")}  grep(updateRole in test)  ${style.warning("running")}`,
    "",
    rule(width),
    style.bold("Send to reviewer"),
    `┌ ${style.selected("Also check organization removal._")}`,
    `└ ${style.muted("enter steer · alt+enter follow-up")}`,
  ];
}

// 3: top tabs and balanced master/detail columns.
function balancedMasterDetail(page) {
  const [left, right] = page === "sessions"
    ? [balancedSessionList(), sessionInspector(78)]
    : page === "agents"
      ? [balancedAgentList(), balancedAgentInspector()]
      : [balancedAttachmentList(), balancedAttachInspector()];
  return frame("Subagents", [
    ` ${tabs(page === "attach" ? "attached" : page)}`,
    ` ${filter("", page === "attach" ? "find in transcript" : "type to filter")}`,
    rule(116),
    ...columns(left, 35, right, 78),
  ], "↑↓ select · enter inspect · / filter · a attach · s settings · esc close");
}

function balancedSessionList() {
  return [
    style.muted("SESSIONS · 6"),
    style.selected("● reviewer"),
    style.selected("  Authorization boundary review"),
    style.muted("  1m42s · 12.8k · 1 child"),
    "",
    "● tester",
    "  Cross-tenant regression coverage",
    style.muted("  38s · 6.2k · child"),
    "",
    "○ reviewer",
    "  Recursive cancellation audit",
    style.muted("  queued"),
    "",
    "✓ scout",
    "  Authentication entry-point map",
    style.muted("  completed · retained"),
  ];
}

function balancedAgentList() {
  return [
    style.muted("AGENT DEFINITIONS · 8"),
    style.selected("reviewer"),
    style.muted("  project · sonnet-4"),
    "",
    "worker",
    style.muted("  project · sonnet-4"),
    "",
    "scout",
    style.muted("  user · haiku-4"),
    "",
    "security-reviewer",
    style.muted("  user · opus-4.1"),
    "",
    "test-runner",
    style.muted("  project · default model"),
  ];
}

function balancedAttachmentList() {
  return [
    style.muted("ATTACH TO SESSION"),
    style.selected("● reviewer"),
    style.selected("  Authorization boundary review"),
    style.muted("  attached · bold-mouse"),
    "",
    "  ├─ ● tester",
    "  │    Cross-tenant coverage",
    "  └─ ✓ scout",
    "       Auth entry points",
    "",
    "○ reviewer",
    "  Recursive cancellation audit",
    style.muted("  queued · silver-owl"),
  ];
}

function balancedAgentInspector() {
  return [
    `${style.bold("reviewer")}  ${style.muted("project definition")}`,
    "Find correctness risks and return concise file-backed evidence.",
    rule(78),
    `${style.muted("Model")}       anthropic/claude-sonnet-4`,
    `${style.muted("Thinking")}    high`,
    `${style.muted("Tools")}       read, grep, bash`,
    `${style.muted("Skills")}      review`,
    `${style.muted("Resumable")}   yes`,
    `${style.muted("Source")}      .pi/agents/reviewer.md`,
    "",
    style.bold("Best for"),
    "Pre-merge reviews, regressions, and correctness investigations.",
    "",
    `${style.selected("[ Copy agent name ]")}  [ Open definition ]`,
  ];
}

function balancedAttachInspector() {
  return [
    `${glyph("running")} ${style.bold("reviewer / Authorization boundary review")}  ${style.muted("1m42s · 12.8k")}`,
    rule(78),
    `${style.muted("12:41:02  task")}  Review refresh-token invalidation after role changes.`,
    `${style.muted("12:41:09  note")}  Found the invalidation hook; tracing role mutations.`,
    `${style.muted("12:41:14  tool")}  ${style.accent("grep(sessionVersion)")} ${style.success("18 matches")}`,
    `${style.muted("12:41:31  tool")}  ${style.accent("read(admin/users.ts)")} ${style.success("done")}`,
    `${style.muted("12:41:44  note")}  Two admin paths update roles directly.`,
    `${style.muted("12:41:46  tool")}  ${style.accent("grep(updateRole in test)")} ${style.warning("running")}`,
    "",
    rule(78),
    `${style.bold("Send to reviewer")}`,
    `┌ ${style.selected("Also check organization removal and invitation revocation._")}`,
    `└ ${style.muted("enter steer · alt+enter follow-up · shift+enter newline")}`,
  ];
}

// 4: hierarchy is the primary navigation structure.
function hierarchicalMasterDetail(page) {
  const [tree, detail] = page === "sessions"
    ? [hierarchySessions(), hierarchySessionDetail()]
    : page === "agents"
      ? [hierarchyAgents(), hierarchyAgentDetail()]
      : [hierarchyAttachments(), hierarchyAttachDetail()];
  return frame("Subagents", [
    ` ${tabs(page === "attach" ? "attached" : page)}`,
    rule(116),
    ...columns(tree, 40, detail, 73),
  ], "↑↓ navigate tree · ←→ fold · / filter · enter inspect · a attach · esc close");
}

function hierarchySessions() {
  return [
    `${style.bold("Session hierarchy")}  ${style.muted("6 total")}`,
    filter(""),
    rule(40),
    style.selected("▾ ● Authorization boundary review"),
    style.selected("    reviewer · bold-mouse · 1m42s"),
    "  ├─ ● Cross-tenant regression coverage",
    style.muted("  │    tester · amber-fox · 38s"),
    "  └─ ✓ Authentication entry-point map",
    style.muted("       scout · cedar-lark · done"),
    "",
    "▸ ○ Recursive cancellation audit",
    style.muted("    reviewer · silver-owl · queued"),
    "",
    "  ✓ Documentation preview",
    style.muted("    docs-writer · retained"),
  ];
}

function hierarchyAgents() {
  return [
    `${style.bold("Agent definitions")}  ${style.muted("8 total")}`,
    filter(""),
    rule(40),
    "▾ Project  .pi/agents",
    style.selected("  ▸ reviewer"),
    "    worker",
    "    test-runner",
    "    docs-writer",
    "    api-reviewer",
    "",
    "▾ User  ~/.pi/agent/agents",
    "    scout",
    "    security-reviewer",
    "    planner",
  ];
}

function hierarchyAttachments() {
  return [
    `${style.bold("Attached session")}  ${style.muted("live")}`,
    filter("", "find session or transcript"),
    rule(40),
    style.selected("▾ ● reviewer · bold-mouse"),
    style.selected("    Authorization boundary review"),
    "  ├─ ● tester · amber-fox",
    style.muted("  │    Cross-tenant regression coverage"),
    "  └─ ✓ scout · cedar-lark",
    style.muted("       Authentication entry-point map"),
    "",
    style.muted("Attachment follows the selected node."),
    style.muted("Tab moves attachment parent → child."),
  ];
}

function hierarchySessionDetail() {
  return [
    `${glyph("running")} ${style.bold("Authorization boundary review")}`,
    style.muted("reviewer · foreground · resumable · session bold-mouse"),
    rule(73),
    style.bold("Purpose"),
    "Trace why refresh tokens survive organization role downgrades.",
    "",
    style.bold("Current activity"),
    `${style.accent("grep(sessionVersion in src/auth)")}  ${style.muted("running · 2s")}`,
    style.muted("3 turns · 7 tools · 12.8k tokens · $0.041"),
    "",
    style.bold("Subtree"),
    "2 children · 1 running · 1 completed · 10.3k combined tokens",
    "",
    `${style.selected("[ Attach subtree ]")}  [ Steer parent ]  [ Stop ]`,
  ];
}

function hierarchyAgentDetail() {
  return [
    `${style.bold("reviewer")}  ${style.muted("project definition")}`,
    "Find correctness risks and return evidence with file references.",
    rule(73),
    "anthropic/claude-sonnet-4 · high thinking · resumable",
    "read, grep, bash · review skill",
    "",
    style.bold("Use this agent for"),
    "• Reviewing finished implementation changes",
    "• Finding regressions and missing edge cases",
    "• Producing evidence tied to exact files and lines",
    "",
    style.muted("Source  .pi/agents/reviewer.md"),
    "",
    `${style.selected("[ Copy reviewer ]")}  [ Open source ]`,
  ];
}

function hierarchyAttachDetail() {
  return [
    `${glyph("running")} ${style.bold("reviewer")}  ${style.muted("bold-mouse · attached live")}`,
    rule(73),
    `${style.muted("YOU")}  Review refresh-token invalidation after role changes.`,
    "",
    `${style.accent("REVIEWER")}  Found the invalidation hook; tracing role mutations.`,
    "",
    `${style.muted("tool")}  grep(sessionVersion)  ${style.success("18 matches · 2s")}`,
    `${style.muted("tool")}  read(admin/users.ts)  ${style.success("done")}`,
    `${style.muted("child")} tester / Cross-tenant coverage  ${style.accent("running")}`,
    "",
    `${style.accent("REVIEWER")}  Two admin paths update roles directly.`,
    "",
    rule(73),
    `┌ ${style.selected("Steer the attached reviewer…_")}`,
    `└ ${style.muted("enter send · alt+enter follow-up · tab attach child")}`,
  ];
}

// 5: compact rail and vertically stacked list/detail, suited to narrower overlays.
function compactRailInspector(page) {
  const rail = [
    style.title(" SUB"),
    "",
    page === "sessions" ? style.selected(" ▸ Runs") : "   Runs",
    page === "agents" ? style.selected(" ▸ Agents") : "   Agents",
    page === "attach" ? style.selected(" ▸ Live") : "   Live",
    "   Setup",
    "",
    style.muted(" ● 2"),
    style.muted(" ○ 1"),
    style.muted(" ✓ 3"),
  ];
  const body = page === "sessions"
    ? stackedSessions()
    : page === "agents"
      ? stackedAgents()
      : stackedAttach();
  return frame("Subagents", columns(rail, 12, body, 101), "tab section · ↑↓ select · / filter · enter focus · a attach · esc close");
}

function stackedSessions() {
  return [
    `${style.bold("Sessions")}   ${filter("auth")}   ${style.muted("3 of 6")}`,
    rule(101),
    `${style.muted("ST  AGENT       TASK                                         AGE    TOOLS   TOKENS")}`,
    `${style.selected("●   reviewer    Authorization boundary review                1:42   7       12.8k")}`,
    `●   tester      Cross-tenant regression coverage             0:38   4        6.2k`,
    `✓   scout       Authentication entry-point map               done   5        4.1k`,
    rule(101),
    `${glyph("running")} ${style.bold("Authorization boundary review")}  ${style.muted("reviewer · bold-mouse · resumable")}`,
    "Trace why refresh tokens survive organization role downgrades.",
    "",
    `${style.muted("Now")}       ${style.accent("grep(sessionVersion in src/auth)")} · 2s`,
    `${style.muted("Children")}  ${glyph("running")} tester · Cross-tenant coverage · 38s`,
    `${style.muted("Usage")}     3 turns · 7 tools · 12.8k tokens · $0.041`,
    "",
    `${style.selected("[ Attach ]")}  [ Steer ]  [ Stop ]`,
  ];
}

function stackedAgents() {
  return [
    `${style.bold("Agent definitions")}   ${filter("")}   ${style.muted("8 total")}`,
    rule(101),
    `${style.muted("AGENT               SOURCE    MODEL       MODE        PURPOSE")}`,
    `${style.selected("reviewer            project   sonnet-4    resumable   Evidence-backed correctness review")}`,
    `worker              project   sonnet-4    resumable   Focused implementation and verification`,
    `security-reviewer   user      opus-4.1    one-shot    Trust-boundary and authorization audit`,
    rule(101),
    `${style.bold("reviewer")}  ${style.muted("project definition · .pi/agents/reviewer.md")}`,
    "Find correctness risks and return concise evidence with file references.",
    "",
    `${style.muted("Model")}       anthropic/claude-sonnet-4 · high thinking`,
    `${style.muted("Tools")}       read, grep, bash`,
    `${style.muted("Skills")}      review`,
    `${style.muted("Best for")}    pre-merge reviews, regressions, and missing edge cases`,
    "",
    `${style.selected("[ Copy name ]")}  [ Open definition ]`,
  ];
}

function stackedAttach() {
  return [
    `${glyph("completed")} ${style.bold("reviewer / Authorization boundary review")}  ${style.success("completed")}  ${style.muted("2m11s · 18.4k · retained")}`,
    style.muted("Sending a message resumes the same conversation; running sessions receive steering immediately."),
    rule(101),
    `${style.muted("YOU")}       Review refresh-token invalidation after role changes.`,
    `${style.accent("REVIEWER")}  Found the invalidation hook and traced every role mutation.`,
    `${style.muted("TOOL")}      grep(sessionVersion)  ${style.success("18 matches · 2s")}`,
    `${style.accent("REVIEWER")}  Two admin paths bypass invalidation and lack focused tests.`,
    "",
    `${style.bold("Last answer")}`,
    "Use one shared invalidation helper in both admin mutation paths and add downgrade coverage.",
    rule(101),
    `${style.bold("Resume reviewer")}`,
    `┌ ${style.selected("Implement the helper and run the focused authorization tests._")}`,
    `└ ${style.muted("enter resume · shift+enter newline · ctrl+o previous runs")}`,
  ];
}
