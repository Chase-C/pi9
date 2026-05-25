import type { Component } from "@earendil-works/pi-tui";

import { accent, dim, fitLinesToWidth, isCancelKey, type SubagentKeybindings, type SubagentSessionsTheme } from "../input.js";

export class SubagentResumeLoader implements Component {
  private readonly controller = new AbortController();

  constructor(private readonly theme: SubagentSessionsTheme, private readonly keybindings: SubagentKeybindings, private readonly message: string) { }

  get signal() { return this.controller.signal; }

  invalidate(): void { }

  render(width: number) { return fitLinesToWidth([accent(this.theme, this.message), dim(this.theme, "esc cancel")], width); }

  handleInput(data: string) {
    if (isCancelKey(data, this.keybindings)) this.controller.abort();
  }

  dispose(): void { }

}
