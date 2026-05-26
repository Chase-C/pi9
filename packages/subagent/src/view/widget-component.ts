import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { formatThemedWidgetRow, renderWidgetModelLines, type WidgetModel } from "./session-lines.js";

export class SubagentWidgetComponent implements Component {
  constructor(
    private readonly model: WidgetModel,
    private readonly theme: Theme | undefined,
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    const lines = renderWidgetModelLines(this.model, Date.now(), row => formatThemedWidgetRow(row, this.theme));
    return lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
  }
}
