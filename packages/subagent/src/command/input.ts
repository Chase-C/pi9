import { matchesKey, truncateToWidth, visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";

import type { AgentSnapshot } from "../domain/agent-snapshot.js";

export type SubagentSessionsTheme = {
  fg?: (color: "accent" | "dim", text: string) => string;
  bold?: (text: string) => string;
};

export type SubagentKeybindings = Pick<KeybindingsManager, "matches"> | undefined;

export function fitLinesToWidth(lines: string[], width: number) {
  return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export type ListInspectMode = "list" | "inspect";
export type ListInspectState = { selected: number; mode: ListInspectMode };

export function accent(theme: SubagentSessionsTheme, text: string) {
  return theme.fg?.("accent", theme.bold?.(text) ?? text) ?? text;
}

export function dim(theme: SubagentSessionsTheme, text: string) {
  return theme.fg?.("dim", text) ?? text;
}

export function selectedListLines<T>(
  items: readonly T[],
  selected: number,
  renderItem: (item: T, index: number) => string,
  theme: SubagentSessionsTheme,
) {
  return items.map((item, index) => {
    const prefix = index === selected ? "> " : "  ";
    const line = `${prefix}${renderItem(item, index)}`;
    return index === selected ? accent(theme, line) : line;
  });
}

export function handleListInspectNavigation(
  data: string,
  state: ListInspectState,
  count: number,
  keybindings: SubagentKeybindings,
  requestRender: () => void,
) {
  if (state.mode === "inspect" && (data === "b" || data === "B")) {
    state.mode = "list";
    requestRender();
    return true;
  }
  if (isEnterKey(data, keybindings) && count > 0) {
    state.mode = "inspect";
    requestRender();
    return true;
  }
  if (state.mode === "list" && isUpKey(data, keybindings)) {
    state.selected = clamp(state.selected - 1, 0, Math.max(0, count - 1));
    requestRender();
    return true;
  }
  if (state.mode === "list" && isDownKey(data, keybindings)) {
    state.selected = clamp(state.selected + 1, 0, Math.max(0, count - 1));
    requestRender();
    return true;
  }
  return false;
}

export function agentListHelp() {
  return "↑↓ select · enter inspect · s settings · esc close";
}

export function agentInspectHelp() {
  return "b back · s settings · esc close";
}

export function listHelp(session: AgentSnapshot | undefined) {
  const actions = ["↑↓ select", "enter inspect"];
  if (session?.capabilities.canResume) actions.push("r resume");
  actions.push("c remove retained", "esc close");
  return actions.join(" · ");
}

export function inspectHelp(session: AgentSnapshot) {
  const actions = [];
  if (session.capabilities.canResume) actions.push("r resume");
  if (session.capabilities.canClear) actions.push("c remove");
  actions.push("b back", "esc close");
  return actions.join(" · ");
}

function keybindingsMatch(keybindings: SubagentKeybindings, data: string, keybinding: "tui.select.cancel" | "tui.select.confirm" | "tui.select.up" | "tui.select.down") {
  try {
    return keybindings?.matches(data, keybinding) ?? false;
  } catch {
    return false;
  }
}

export function isEnterKey(data: string, keybindings?: SubagentKeybindings) {
  return keybindingsMatch(keybindings, data, "tui.select.confirm") || matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || data === "\n";
}

export function isCancelKey(data: string, keybindings?: SubagentKeybindings) {
  return keybindingsMatch(keybindings, data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "\x1b" || data === "\u0003";
}

export function isUpKey(data: string, keybindings?: SubagentKeybindings) {
  return keybindingsMatch(keybindings, data, "tui.select.up") || matchesKey(data, "up") || data === "\x1b[A" || data === "k" || data === "K";
}

export function isDownKey(data: string, keybindings?: SubagentKeybindings) {
  return keybindingsMatch(keybindings, data, "tui.select.down") || matchesKey(data, "down") || data === "\x1b[B" || data === "j" || data === "J";
}
