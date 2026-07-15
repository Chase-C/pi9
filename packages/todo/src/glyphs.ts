import type { TodoStatus } from "./types.js";

export type TodoGlyphs = Record<TodoStatus, string>;

export const WORKING_SPINNER_FRAMES = ["󰅂", "󰄾", "󰶻", "󰄾"] as const;
export const IDLE_WORKING_GLYPH = "󰅂";
export const TOOL_FRAME_STATE_GLYPHS = {
  pending: "●",
  success: "✓",
  error: "✗",
} as const;
export const TODO_EXPAND_GLYPH = "↵";
export const TODO_SEPARATOR_GLYPH = "·";
export const TODO_DESCRIPTION_SEPARATOR_GLYPH = "—";
export const TODO_TRUNCATION_GLYPH = "…";

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
