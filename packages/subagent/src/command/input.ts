import { matchesKey, truncateToWidth, visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export type SubagentKeybindings = Pick<KeybindingsManager, "matches"> | undefined;

export function fitLinesToWidth(lines: string[], width: number) {
  return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function accent(theme: Theme, text: string) {
  return theme.fg?.("accent", theme.bold?.(text) ?? text) ?? text;
}

function keybindingsMatch(
  keybindings: SubagentKeybindings,
  data: string,
  keybinding: "tui.select.cancel" | "tui.select.confirm" | "tui.select.up" | "tui.select.down",
) {
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
