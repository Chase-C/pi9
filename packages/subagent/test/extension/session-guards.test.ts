import { expect, test, vi } from "vitest";
import { confirmWithActiveSubagents, registerSubagentSessionGuards } from "../../src/index.js";

const generation = (status: any) => ({ generation: 1, status });
const conversation = (options: { label?: string; status?: any; isStopping?: boolean } = {}) => {
  const current = options.status && options.status.kind !== "done" ? generation(options.status) : undefined;
  return {
    conversationId: "amber-acorn",
    label: options.label ?? "helper",
    agent: { name: "helper" },
    generations: [current ?? generation({ kind: "done", outcome: "completed", completedAt: 2 })],
    ...(current ? { currentGeneration: current } : {}),
    ...(options.isStopping ? { isStopping: true } : {}),
  } as any;
};
const manager = (items: any[]) => ({ listConversations: () => items });

test("declining runtime teardown cancels switching when a generation is active", async () => {
  const confirm = vi.fn().mockResolvedValue(false);
  const active = conversation({ label: "review", status: { kind: "running", startedAt: 1 } });
  await expect(confirmWithActiveSubagents({ hasUI: true, ui: { confirm } }, manager([active]))).resolves.toEqual({ cancel: true });
  expect(confirm).toHaveBeenCalledWith("Active subagents", expect.stringContaining("helper (review): running"));
  expect(confirm.mock.calls[0][1]).toContain("tear down this extension runtime");
});

test("a stopping cancelled subagent blocks teardown", async () => {
  const confirm = vi.fn().mockResolvedValue(false);
  const stopping = conversation({ isStopping: true });

  await expect(confirmWithActiveSubagents({ hasUI: true, ui: { confirm } }, manager([stopping]))).resolves.toEqual({ cancel: true });
  expect(confirm).toHaveBeenCalledWith("Active subagents", expect.stringContaining("helper: stopping"));
});

test("completed work or unavailable UI does not block teardown", async () => {
  const confirm = vi.fn();
  await expect(confirmWithActiveSubagents({ hasUI: true, ui: { confirm } }, manager([conversation()]))).resolves.toBeUndefined();
  await expect(confirmWithActiveSubagents({ hasUI: false }, manager([conversation({ status: { kind: "queued", queuedAt: 1 } })]))).resolves.toBeUndefined();
  expect(confirm).not.toHaveBeenCalled();
});

test("both SDK teardown entry points use the same guard", async () => {
  const handlers = new Map<string, Function>();
  registerSubagentSessionGuards({ on: (event, handler) => { handlers.set(event, handler); } }, manager([conversation({ status: { kind: "queued", queuedAt: 1 } })]));
  expect([...handlers.keys()]).toEqual(["session_before_switch", "session_before_fork"]);
  const ctx = { hasUI: true, ui: { confirm: vi.fn().mockResolvedValue(false) } };
  await expect(handlers.get("session_before_fork")!({}, ctx)).resolves.toEqual({ cancel: true });
});
