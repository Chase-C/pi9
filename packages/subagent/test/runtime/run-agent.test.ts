import { expect, test, vi } from "vitest";
import { Agent } from "../../src/domain/agent.js";
import { completedRun } from "../../src/domain/agent-finalize.js";
import { RunAttempt } from "../../src/runtime/run-agent.js";

const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
function resumable(messages: any[], prompt: () => Promise<void>, abort = vi.fn()) {
  const agent = new Agent("amber-acorn" as any, "adapt-ably" as any, config, { kind: "spawn", agent: "worker", prompt: "first" }, () => {});
  const session = { messages, subscribe: () => () => {}, prompt, abort } as any;
  agent.bindSession(session); completedRun(agent, "adapt-ably" as any, "first");
  const attempt = agent.beginResume("balance-boldly" as any, "continue");
  return { agent, attempt, session, abort };
}

test("resume completes with the final assistant text", async () => {
  const f = resumable([{ role: "assistant", content: [{ type: "text", text: "finished" }] }], async () => {});
  await expect(RunAttempt({} as any, f.agent, f.attempt)).resolves.toMatchObject({ status: { kind: "done", outcome: "completed", output: "finished" } });
});

test("assistant errors and prompt failures terminalize the run as errors", async () => {
  const modelError = resumable([{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "model failed" }], async () => {});
  await expect(RunAttempt({} as any, modelError.agent, modelError.attempt)).resolves.toMatchObject({ status: { kind: "done", outcome: "error", error: "model failed" } });
  const thrown = resumable([], async () => { throw new Error("transport failed"); });
  await expect(RunAttempt({} as any, thrown.agent, thrown.attempt)).resolves.toMatchObject({ status: { kind: "done", outcome: "error", error: "transport failed" } });
});

test("cancellation aborts the SDK session and records interruption", async () => {
  let reject!: (error: Error) => void;
  const f = resumable([], () => new Promise<void>((_, r) => { reject = r; }));
  const controller = new AbortController();
  const result = RunAttempt({} as any, f.agent, f.attempt, controller.signal);
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  controller.abort(); reject(new Error("cancelled"));
  await expect(result).resolves.toMatchObject({ status: { kind: "done", outcome: "interrupted", error: "cancelled" } });
  expect(f.abort).toHaveBeenCalled();
});
