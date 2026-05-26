import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export type DisplayLine = { text: string; color?: ThemeColor; hangingIndent?: number };
export type Bold = ((text: string) => string) | undefined;

export function applyBold(bold: Bold, text: string): string {
  return bold ? bold(text) : text;
}

export class SubagentTextComponent implements Component {
  constructor(private readonly lines: DisplayLine[], private readonly theme: Theme | undefined) { }

  invalidate(): void { }

  render(width: number): string[] {
    return this.lines.flatMap(line => wrapDisplayLine(line, width).map(wrapped => colorLine(wrapped, line.color, this.theme)));
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

function colorLine(line: string, color: ThemeColor | undefined, theme: Theme | undefined) {
  if (!theme?.fg) return line;
  return theme.fg(color ?? "muted", line);
}
