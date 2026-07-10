import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export type WidgetComponentFactory = (tui: unknown, theme: Theme) => Component & { dispose?(): void };

export function passthroughTheme(): Theme {
  return { fg: (_color: string, text: string) => text } as Theme;
}

export function mockTheme(): Theme {
  return {
    fg(color: string, text: string) {
      return `[${color}]${text}[/]`;
    },
  } as Theme;
}

/** Render widget content from a component-factory setWidget call. */
export function renderWidgetContent(
  content: unknown,
  theme: Theme = passthroughTheme(),
  width = 80,
): string[] {
  if (typeof content !== "function") return [];
  const component = (content as WidgetComponentFactory)({}, theme);
  return component.render(width);
}
