import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type DisplayStatus = "queued" | "running" | "completed" | "error" | "warning";
export type DisplayLine = { text: string; status?: DisplayStatus; hangingIndent?: number };
export type Theme = { fg?: (color: string, text: string) => string; bold?: (text: string) => string } | undefined;
export type Bold = ((text: string) => string) | undefined;

export function applyBold(bold: Bold, text: string): string {
  return bold ? bold(text) : text;
}

export class SubagentTextComponent implements Component {
  constructor(private readonly lines: DisplayLine[], private readonly theme: Theme) { }

  invalidate(): void { }

  render(width: number): string[] {
    return this.lines.flatMap(line => wrapDisplayLine(line, width).map(wrapped => colorLine(wrapped, line.status, this.theme)));
  }
}

function wrapDisplayLine(line: DisplayLine, width: number): string[] {
  if (!line.text) return [""];
  const indent = line.hangingIndent ?? 0;
  if (indent <= 0 || width <= indent + 1) return wrapTextWithAnsi(line.text, Math.max(1, width));

  const prefix = " ".repeat(indent);
  const content = line.text.startsWith(prefix) ? line.text.slice(indent) : line.text;
  return wrapTextWithAnsi(content, Math.max(1, width - indent)).map(wrapped => `${prefix}${wrapped}`);
}

function colorLine(line: string, status: DisplayStatus | undefined, theme: Theme) {
  if (!theme?.fg) return line;
  if (status === "error") return theme.fg("error", line);
  if (status === "warning") return theme.fg("warning", line);
  if (status === "completed") return theme.fg("success", line);
  if (status === "running") return theme.fg("accent", line);
  return theme.fg("muted", line);
}
