import type { TodoStatus } from "./types.js";

export type TodoGlyphs = Record<TodoStatus, string>;

export const NERD_FONT_TODO_GLYPHS: TodoGlyphs = {
  pending: "󰄰",
  in_progress: "󰻃",
  completed: "󰄴",
  cancelled: "󰍷",
};

export const FALLBACK_TODO_GLYPHS: TodoGlyphs = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  cancelled: "×",
};

export function todoGlyph(status: TodoStatus, fallbackGlyphs = false): string {
  return (fallbackGlyphs ? FALLBACK_TODO_GLYPHS : NERD_FONT_TODO_GLYPHS)[status];
}
