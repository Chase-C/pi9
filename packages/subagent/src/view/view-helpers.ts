import { DEFAULT_SUBAGENT_SETTINGS } from "../config/settings.js";

export const OUTPUT_SNIPPET_MAX_LINES = DEFAULT_SUBAGENT_SETTINGS.display.outputSnippetMaxLines;

export function compact(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

export function compactMultiline(value: string, maxLength: number, maxLines = OUTPUT_SNIPPET_MAX_LINES) {
  const rawLines = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.replace(/[^\S\n]+/g, " ").trim());

  // Collapse runs of blank lines and trim blank lines from edges.
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line === "" && lines[lines.length - 1] === "") continue;
    lines.push(line);
  }
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  let truncated = false;
  let limited = lines;
  if (limited.length > maxLines) {
    limited = limited.slice(0, maxLines);
    truncated = true;
  }

  let result = limited.join("\n");
  if (result.length > maxLength) {
    result = result.slice(0, Math.max(0, maxLength - 1)).trimEnd();
    truncated = true;
  }
  return truncated ? `${result}…` : result;
}
