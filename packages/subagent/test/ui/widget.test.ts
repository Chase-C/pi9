import { describe, expect, it, vi } from "vitest";
import { registerSubagentWidgetLifecycle } from "../../src/ui/widget.js";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/config/settings.js";
describe("widget lifecycle", () => {
  it("refreshes the active UI when the manager updates", () => {
    const handlers: Record<string, any> = {}; let update: (() => void) | undefined;
    const setWidget = vi.fn();
    const source = { listConversations: vi.fn(() => []), onAgentUpdate: vi.fn((listener: () => void) => { update = listener; return () => {}; }) };
    registerSubagentWidgetLifecycle({ on(event, value) { handlers[event] = value; } }, source, () => DEFAULT_SUBAGENT_SETTINGS);
    handlers.session_start({}, { hasUI: true, ui: { setWidget } });
    setWidget.mockClear(); update?.();
    expect(source.listConversations).toHaveBeenCalledTimes(2);
    expect(setWidget).toHaveBeenCalled();
  });

  it("does not refresh a shut down UI", () => {
    const handlers: Record<string, any> = {}; let update: (() => void) | undefined;
    const setWidget = vi.fn();
    const source = { listConversations: () => [], onAgentUpdate(listener: () => void) { update = listener; return () => {}; } };
    registerSubagentWidgetLifecycle({ on(event, value) { handlers[event] = value; } }, source, () => DEFAULT_SUBAGENT_SETTINGS);
    const ctx = { hasUI: true, ui: { setWidget } };
    handlers.session_start({}, ctx); handlers.session_shutdown({}, ctx); setWidget.mockClear(); update?.();
    expect(setWidget).not.toHaveBeenCalled();
  });
});
