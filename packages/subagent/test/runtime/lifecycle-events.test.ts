import { test, expect } from "vitest";
import { AgentManager } from "../../src/runtime/agent-manager.js";
import { registerSubagentLifecycleEvents } from "../../src/runtime/lifecycle-events.js";

const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
const registry = { agents: new Map([["worker", config]]) } as any;

test("spawn publishes queued after manager conversation and run indexes exist", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const manager = new AgentManager(registry, 1, (async () => { await gate; return { status: "completed" }; }) as any);
  const emitted: Array<{ event: string; data: any }> = [];
  const unsubscribe = registerSubagentLifecycleEvents({ emit: (event, data) => emitted.push({ event, data }) }, manager);
  const started = manager.startRun({ cwd: "/tmp" } as any, [{ kind: "spawn", agent: "worker", prompt: "work" }] as any);
  const identity = started.starts[0] as any;
  const queued = emitted.find(value => value.event === "subagent:queued")!;
  expect(queued.data).toMatchObject({ conversationId: identity.conversationId, runId: identity.runId });
  expect(manager.conversation(identity.conversationId).runs.some(run => run.runId === identity.runId)).toBe(true);
  expect(() => manager.bindJoin([identity.runId])).not.toThrow();
  release(); await started.completion; unsubscribe();
});
