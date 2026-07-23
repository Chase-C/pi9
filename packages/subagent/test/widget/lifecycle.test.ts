import { describe, expect, it, vi } from "vitest";
import { registerSubagentWidgetLifecycle, updateSubagentWidget } from "../../src/widget.js";
import { createDefaultSubagentSettings, DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";
import { fakeAgent } from "../helpers/fake-agent.js";
import { passthroughTheme } from "../helpers/render-widget.js";
describe("widget lifecycle", () => {
  it("refreshes the active UI when the manager updates", () => {
    const handlers: Record<string, any> = {}; let update: (() => void) | undefined;
    const setWidget = vi.fn();
    const source = { listConversations: vi.fn(() => []), onConversationUpdate: vi.fn((listener: () => void) => { update = listener; return () => {}; }) };
    registerSubagentWidgetLifecycle({ on(event, value) { handlers[event] = value; } }, source, () => DEFAULT_SUBAGENT_SETTINGS);
    handlers.session_start({}, { hasUI: true, ui: { setWidget } });
    setWidget.mockClear(); update?.();
    expect(source.listConversations).toHaveBeenCalledTimes(2);
    expect(setWidget).toHaveBeenCalled();
  });

  it("coalesces activity refreshes but applies status updates promptly", () => {
    vi.useFakeTimers();
    try {
      const handlers: Record<string, any> = {}; let update: any;
      const setWidget = vi.fn();
      const source = {
        listConversations: () => [],
        onConversationUpdate(listener: any) { update = listener; return () => {}; },
      };
      registerSubagentWidgetLifecycle({ on(event, value) { handlers[event] = value; } }, source, () => DEFAULT_SUBAGENT_SETTINGS);
      handlers.session_start({}, { hasUI: true, ui: { setWidget } });
      setWidget.mockClear();

      update(undefined, "message");
      update(undefined, "tool");
      update(undefined, "message");
      vi.advanceTimersByTime(99);
      expect(setWidget).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(setWidget).toHaveBeenCalledTimes(1);
      setWidget.mockClear();

      update(undefined, "status");
      expect(setWidget).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears pending activity refreshes and subscriptions on shutdown", () => {
    vi.useFakeTimers();
    try {
      const handlers: Record<string, any> = {}; let update: any;
      const unsubscribe = vi.fn();
      const setWidget = vi.fn();
      const source = {
        listConversations: () => [],
        onConversationUpdate(listener: any) { update = listener; return unsubscribe; },
      };
      registerSubagentWidgetLifecycle({ on(event, value) { handlers[event] = value; } }, source, () => DEFAULT_SUBAGENT_SETTINGS);
      const ctx = { hasUI: true, ui: { setWidget } };
      handlers.session_start({}, ctx);
      setWidget.mockClear();
      update(undefined, "message");
      handlers.session_shutdown({}, ctx);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      setWidget.mockClear();
      vi.advanceTimersByTime(100);
      expect(setWidget).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests periodic renders while progress is active and disposes its timer", () => {
    vi.useFakeTimers();
    try {
      const settings = createDefaultSubagentSettings();
      settings.widgetMode = "progress";
      const setWidget = vi.fn();
      const requestRender = vi.fn();
      updateSubagentWidget(
        { hasUI: true, ui: { setWidget } },
        [fakeAgent({ status: { kind: "running", startedAt: 1 } })],
        settings,
      );
      const component = setWidget.mock.calls[0]![1]({ requestRender }, passthroughTheme());

      vi.advanceTimersByTime(1_000);
      expect(requestRender).toHaveBeenCalledTimes(1);
      component.dispose?.();
      vi.advanceTimersByTime(1_000);
      expect(requestRender).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not refresh a shut down UI", () => {
    const handlers: Record<string, any> = {}; let update: ((...args: any[]) => void) | undefined;
    const setWidget = vi.fn();
    const source = { listConversations: () => [], onConversationUpdate(listener: (...args: any[]) => void) { update = listener; return () => {}; } };
    registerSubagentWidgetLifecycle({ on(event, value) { handlers[event] = value; } }, source, () => DEFAULT_SUBAGENT_SETTINGS);
    const ctx = { hasUI: true, ui: { setWidget } };
    handlers.session_start({}, ctx); handlers.session_shutdown({}, ctx); setWidget.mockClear(); update?.();
    expect(setWidget).not.toHaveBeenCalled();
  });
});
