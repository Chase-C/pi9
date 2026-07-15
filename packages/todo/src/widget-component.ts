import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { IDLE_WORKING_GLYPH, WORKING_SPINNER_FRAMES } from "./glyphs.js";
import type { TodoState } from "./types.js";
import { renderTodoWidgetLines, type TodoWidgetLayoutOptions } from "./widget-layout.js";

const PI_SPINNER_INTERVAL_MS = 120;

type TodoWidgetComponentOptions = TodoWidgetLayoutOptions & {
  blankLineBelow?: boolean;
  animateWorkingMarker?: boolean;
};

/** A width-aware component for Pi's persistent widget area. */
export class TodoWidgetComponent implements Component {
  private frameIndex = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly state: TodoState,
    private readonly theme: Theme | undefined,
    private readonly options: TodoWidgetComponentOptions = {},
    private readonly tui?: Pick<TUI, "requestRender">,
  ) {
    if (tui && state.workingOn && options.animateWorkingMarker !== false) {
      this.scheduleNextFrame();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width) || 1);
    const { blankLineBelow, ...layoutOptions } = this.options;
    const lines = renderTodoWidgetLines(this.state, this.theme, safeWidth, {
      ...layoutOptions,
      workingMarker: this.options.animateWorkingMarker === false
        ? IDLE_WORKING_GLYPH
        : WORKING_SPINNER_FRAMES[this.frameIndex],
    });
    if (blankLineBelow && lines.length > 0) lines.push("");
    return lines;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNextFrame(): void {
    this.timer = setTimeout(() => {
      this.frameIndex = (this.frameIndex + 1) % WORKING_SPINNER_FRAMES.length;
      this.tui?.requestRender();
      this.scheduleNextFrame();
    }, PI_SPINNER_INTERVAL_MS);
  }
}
