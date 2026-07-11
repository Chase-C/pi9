import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { TodoState } from "./types.js";
import { renderTodoWidgetLines, type TodoWidgetLayoutOptions } from "./widget-layout.js";

/** A width-aware, stateless component for Pi's persistent widget area. */
export class TodoWidgetComponent implements Component {
  constructor(
    private readonly state: TodoState,
    private readonly theme: Theme | undefined,
    private readonly options: TodoWidgetLayoutOptions = {},
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width) || 1);
    return renderTodoWidgetLines(this.state, this.theme, safeWidth, this.options)
      .flatMap(line => wrapTextWithAnsi(line, safeWidth));
  }
}
