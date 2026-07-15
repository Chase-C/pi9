import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (MODEL_THINKING_LEVELS as readonly string[]).includes(value);
}
