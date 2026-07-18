import { expect, test, vi } from "vitest";
import { confirmWithActiveSubagents, registerSubagentSessionGuards } from "../../src/runtime/session-guards.js";
import { fakeAgent } from "../helpers/fake-agent.js";

const manager = (items: any[]) => ({ listConversations: () => items });

test("declining runtime teardown cancels switching when a run is active", async () => {
  const confirm = vi.fn().mockResolvedValue(false);
  const active = fakeAgent({ conversationId: "amber-acorn", label: "review", status: { kind: "running" } });
  await expect(confirmWithActiveSubagents({ hasUI: true, ui: { confirm } }, manager([active]))).resolves.toEqual({ cancel: true });
  expect(confirm).toHaveBeenCalledWith("Active subagents", expect.stringContaining("helper (review): running"));
  expect(confirm.mock.calls[0][1]).toContain("tear down this extension runtime");
});

test("completed work or unavailable UI does not block teardown", async () => {
  const confirm = vi.fn();
  await expect(confirmWithActiveSubagents({ hasUI: true, ui: { confirm } }, manager([fakeAgent()]))).resolves.toBeUndefined();
  await expect(confirmWithActiveSubagents({ hasUI: false }, manager([fakeAgent({ status: { kind: "queued" } })]))).resolves.toBeUndefined();
  expect(confirm).not.toHaveBeenCalled();
});

test("both SDK teardown entry points use the same guard", async () => {
  const handlers = new Map<string, Function>();
  registerSubagentSessionGuards({ on: (event, handler) => { handlers.set(event, handler); } }, manager([fakeAgent({ status: { kind: "queued" } })]));
  expect([...handlers.keys()]).toEqual(["session_before_switch", "session_before_fork"]);
  const ctx = { hasUI: true, ui: { confirm: vi.fn().mockResolvedValue(false) } };
  await expect(handlers.get("session_before_fork")!({}, ctx)).resolves.toEqual({ cancel: true });
});
