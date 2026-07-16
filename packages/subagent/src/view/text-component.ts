import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export type DisplaySegment = { text: string; color?: ThemeColor };
export type DisplayLine = {
  text: string;
  color?: ThemeColor;
  hangingIndent?: number;
  segments?: DisplaySegment[];
  continuationPrefix?: DisplaySegment[];
  truncate?: boolean;
};
export type Bold = ((text: string) => string) | undefined;

export function applyBold(bold: Bold, text: string): string {
  return bold ? bold(text) : text;
}

export class SubagentTextComponent implements Component {
  constructor(private readonly lines: DisplayLine[], private readonly theme: Theme | undefined) { }

  invalidate(): void { }

  render(width: number): string[] {
    return this.lines.flatMap(line => {
      if (!line.segments || !this.theme?.fg) {
        const wrapped = wrapDisplayLine(line, width).map(part => colorLine(part, line.color, this.theme));
        return applyContinuationPrefix(wrapped, line, this.theme);
      }
      const text = line.segments.map(segment => segment.color
        ? this.theme!.fg(segment.color, segment.text)
        : segment.text).join("");
      return applyContinuationPrefix(wrapDisplayLine({ ...line, text }, width), line, this.theme);
    });
  }
}

function wrapDisplayLine(line: DisplayLine, width: number): string[] {
  if (!line.text) return [""];
  if (line.truncate) return [truncateToWidth(line.text, Math.max(1, width), "…")];
  const indent = line.hangingIndent ?? 0;
  if (indent <= 0 || width <= indent + 1) return wrapTextWithAnsi(line.text, Math.max(1, width));

  const leadingSpaces = line.text.match(/^ */)?.[0].length ?? 0;
  const content = line.text.slice(leadingSpaces);
  const wrapped = wrapTextWithAnsi(content, Math.max(1, width - indent));
  return wrapped.map((text, index) => `${" ".repeat(index === 0 ? leadingSpaces : indent)}${text}`);
}

function applyContinuationPrefix(lines: string[], line: DisplayLine, theme: Theme | undefined): string[] {
  if (!line.continuationPrefix || lines.length < 2) return lines;
  const prefix = line.continuationPrefix.map(segment => segment.color && theme?.fg
    ? theme.fg(segment.color, segment.text)
    : segment.text).join("");
  const indent = line.hangingIndent ?? 0;
  return lines.map((part, index) => index === 0 ? part : `${prefix}${part.slice(indent)}`);
}

function colorLine(line: string, color: ThemeColor | undefined, theme: Theme | undefined) {
  if (!theme?.fg) return line;
  return theme.fg(color ?? "muted", line);
}
