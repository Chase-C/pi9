import { test } from "vitest";
import assert from "node:assert/strict";

import { completedRun, interruptedRun } from "../../src/domain/agent-finalize.js";
import { toResultJson } from "../../src/domain/agent-result.js";
import { baseCtx, makeManager } from "../helpers/runtime.js";

test("parent finalizing with error cancels its non-background child via the observer", async () => {
  const aborts: string[] = [];
  const childFlag = { aborted: false };
  const runner = async (_ctx: any, agent: any) => {
    if (agent.spawn.prompt === "parent") {
      // Parent finalizes with error after the child is attached.
      await new Promise(r => setTimeout(r, 20));
      throw new Error("parent boom");
    }
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push(agent.spawn.prompt); childFlag.aborted = true; },
    });
    while (!childFlag.aborted) await new Promise(r => setTimeout(r, 5));
    return interruptedRun(agent, "aborted");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const parentBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "parent" }],
    undefined, { background: false },
  );
  // Wait for parent agent to register.
  await new Promise(r => setTimeout(r, 5));
  const parentId = manager.listSessions().find(s => s.parentSessionId === undefined)!.id;

  const childBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined, { background: false, parentId: parentId },
  );
  await new Promise(r => setTimeout(r, 10));
  assert.equal(
    manager.listSessions().find(s => s.parentSessionId === parentId)?.status.kind,
    "running",
  );

  // Wait for parent to error and observer to fan out.
  const [parentResult] = (await parentBatch.resultsPromise).map(toResultJson);
  const [childResult] = (await childBatch.resultsPromise).map(toResultJson);

  assert.equal(parentResult.status, "error");
  assert.deepEqual(aborts, ["child"], "session.abort called for child");
  assert.equal(childResult.status, "aborted");
  assert.match(childResult.error ?? "", new RegExp(parentId));
  assert.match(childResult.error ?? "", /error/);
});

test("parent finalizing with completed leaves a running non-background child alone", async () => {
  const aborts: string[] = [];
  let releaseParent!: () => void;
  const parentHold = new Promise<void>(r => { releaseParent = r; });
  let releaseChild!: () => void;
  const childHold = new Promise<void>(r => { releaseChild = r; });
  const runner = async (_ctx: any, agent: any) => {
    if (agent.spawn.prompt === "parent") {
      agent.attach({
        messages: [],
        subscribe: () => () => { },
        prompt: async () => { },
        abort: () => { aborts.push("parent"); },
      });
      await parentHold;
      return completedRun(agent, "ok");
    }
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push("child"); },
    });
    await childHold;
    return completedRun(agent, "child-ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const parentBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "parent" }],
    undefined, { background: false },
  );
  await new Promise(r => setTimeout(r, 10));
  const parentId = manager.listSessions().find(s => s.parentSessionId === undefined)!.id;
  assert.equal(manager.listSessions()[0].status.kind, "running");

  // Start the child while the parent is still running.
  const childBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined, { background: false, parentId: parentId },
  );
  await new Promise(r => setTimeout(r, 10));
  assert.equal(
    manager.listSessions().find(s => s.parentSessionId === parentId)?.status.kind,
    "running",
  );

  // Now finalize the parent with completed.
  releaseParent();
  const [parentResult] = (await parentBatch.resultsPromise).map(toResultJson);
  assert.equal(parentResult.status, "completed");

  // Give the observer a chance to (incorrectly) fan out.
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(aborts, [], "no abort should have been triggered when parent completed");

  // Child still completes naturally.
  releaseChild();
  const [childResult] = (await childBatch.resultsPromise).map(toResultJson);
  assert.equal(childResult.status, "completed");
});

test("parent aborted with running background descendant: background survives and completes", async () => {
  const aborts: string[] = [];
  let releaseBg!: () => void;
  const bgHold = new Promise<void>(r => { releaseBg = r; });
  const parentFlag = { aborted: false };
  const runner = async (_ctx: any, agent: any) => {
    if (agent.spawn.prompt === "parent") {
      agent.attach({
        messages: [],
        subscribe: () => () => { },
        prompt: async () => { },
        abort: () => { aborts.push("parent"); parentFlag.aborted = true; },
      });
      while (!parentFlag.aborted) await new Promise(r => setTimeout(r, 5));
      return interruptedRun(agent, "aborted");
    }
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push("bg"); },
    });
    await bgHold;
    return completedRun(agent, "bg-ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const parentBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "parent" }],
    undefined, { background: false },
  );
  await new Promise(r => setTimeout(r, 10));
  const parentId = manager.listSessions().find(s => s.parentSessionId === undefined)!.id;

  const bgBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "bg" }],
    undefined, { background: true, parentId: parentId },
  );
  await new Promise(r => setTimeout(r, 10));

  // Abort the parent (via remove) — observer should NOT cancel the background child.
  await manager.remove({ sessionIds: [parentId] });
  const [parentResult] = (await parentBatch.resultsPromise).map(toResultJson);
  assert.equal(parentResult.status, "aborted");

  // Background child should still be running.
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(aborts.filter(a => a === "bg"), [], "background child must not be aborted");
  const bgView = manager.listSessions().find(s => s.parentSessionId === parentId);
  assert.equal(bgView?.status.kind, "running", "background child still running");

  // It completes naturally.
  releaseBg();
  const [bgResult] = (await bgBatch.resultsPromise).map(toResultJson);
  assert.equal(bgResult.status, "completed");
});

test("background descendants form a cancellation boundary for their own children", async () => {
  const aborts: string[] = [];
  let releaseRoot!: () => void;
  const rootHold = new Promise<void>(r => { releaseRoot = r; });
  let releaseBg!: () => void;
  const bgHold = new Promise<void>(r => { releaseBg = r; });
  let releaseFg!: () => void;
  const fgHold = new Promise<void>(r => { releaseFg = r; });
  const runner = async (_ctx: any, agent: any) => {
    if (agent.spawn.prompt === "root") {
      agent.attach({
        messages: [],
        subscribe: () => () => { },
        prompt: async () => { },
        abort: () => { aborts.push("root"); },
      });
      await rootHold;
      throw new Error("root boom");
    }
    if (agent.spawn.prompt === "bg") {
      agent.attach({
        messages: [],
        subscribe: () => () => { },
        prompt: async () => { },
        abort: () => { aborts.push("bg"); },
      });
      await bgHold;
      return completedRun(agent, "bg-ok");
    }
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push("fg"); },
    });
    await fgHold;
    return completedRun(agent, "fg-ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const rootBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "root" }],
    undefined, { background: false },
  );
  await new Promise(r => setTimeout(r, 10));
  const rootId = manager.listSessions().find(s => s.prompt === "root")!.id;

  const bgBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "bg" }],
    undefined, { background: true, parentId: rootId },
  );
  await new Promise(r => setTimeout(r, 10));
  const bgId = manager.listSessions().find(s => s.prompt === "bg")!.id;

  const fgBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "fg" }],
    undefined, { background: false, parentId: bgId },
  );
  await new Promise(r => setTimeout(r, 10));
  assert.equal(manager.listSessions().find(s => s.prompt === "fg")?.status.kind, "running");

  releaseRoot();
  const [rootResult] = (await rootBatch.resultsPromise).map(toResultJson);
  assert.equal(rootResult.status, "error");

  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(aborts, [], "background subtree must not be aborted when an ancestor errors");

  releaseFg();
  releaseBg();
  const [[fgSnapshot], [bgSnapshot]] = await Promise.all([fgBatch.resultsPromise, bgBatch.resultsPromise]);
  assert.equal(toResultJson(fgSnapshot).status, "completed");
  assert.equal(toResultJson(bgSnapshot).status, "completed");
});

test("parent errors with mix of background and non-background children: only non-background cancelled", async () => {
  const aborts: string[] = [];
  const nonBgFlag = { aborted: false };
  let releaseBg!: () => void;
  const bgHold = new Promise<void>(r => { releaseBg = r; });
  const runner = async (_ctx: any, agent: any) => {
    if (agent.spawn.prompt === "parent") {
      agent.attach({
        messages: [],
        subscribe: () => () => { },
        prompt: async () => { },
        abort: () => { aborts.push("parent"); },
      });
      await new Promise(r => setTimeout(r, 20));
      throw new Error("parent boom");
    }
    if (agent.spawn.prompt === "fg") {
      agent.attach({
        messages: [],
        subscribe: () => () => { },
        prompt: async () => { },
        abort: () => { aborts.push("fg"); nonBgFlag.aborted = true; },
      });
      while (!nonBgFlag.aborted) await new Promise(r => setTimeout(r, 5));
      return interruptedRun(agent, "aborted");
    }
    // bg
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push("bg"); },
    });
    await bgHold;
    return completedRun(agent, "bg-ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  const parentBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "parent" }],
    undefined, { background: false },
  );
  await new Promise(r => setTimeout(r, 5));
  const parentId = manager.listSessions().find(s => s.parentSessionId === undefined)!.id;

  const fgBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "fg" }],
    undefined, { background: false, parentId: parentId },
  );
  const bgBatch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "bg" }],
    undefined, { background: true, parentId: parentId },
  );
  await new Promise(r => setTimeout(r, 10));

  const [parentResult, [fgResult]] = await Promise.all([
    parentBatch.resultsPromise.then(r => toResultJson(r[0])),
    fgBatch.resultsPromise.then(rs => rs.map(toResultJson)),
  ]);

  assert.equal(parentResult.status, "error");
  assert.equal(fgResult.status, "aborted");
  assert.match(fgResult.error ?? "", new RegExp(parentId));
  assert.deepEqual(aborts.filter(a => a === "bg"), [], "background child must not be aborted");

  releaseBg();
  const [bgResult] = (await bgBatch.resultsPromise).map(toResultJson);
  assert.equal(bgResult.status, "completed");
});

test("ParentFinalizePolicy honors the background flag set at startRun time when fanning out cancellation", async () => {
  const aborts: string[] = [];
  let releaseChild!: () => void;
  const childHold = new Promise<void>(r => { releaseChild = r; });
  const runner = async (_ctx: any, agent: any) => {
    agent.attach({
      messages: [],
      subscribe: () => () => { },
      prompt: async () => { },
      abort: () => { aborts.push(agent.spawn.prompt); },
    });
    await childHold;
    return completedRun(agent, "ok");
  };
  const registry = {
    agents: new Map([["worker", { name: "worker", description: "d", systemPrompt: "s", source: "project", resumable: true }]]),
  };
  const manager = makeManager(registry as any, 4, runner);

  // Start the child in background mode directly — promoteToBackground was removed in favor of
  // having callers commit to a dispatch decision when they call startRun.
  const batch = manager.startRun(
    baseCtx(), undefined,
    [{ kind: "spawn", agent: "worker", prompt: "child" }],
    undefined, { background: true, parentId: "parent-1" },
  );
  await new Promise(r => setTimeout(r, 20));

  await manager.cancelDescendantsOf("parent-1", { skipBackground: true, reason: "Parent parent-1 finalized as error" });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(aborts, [], "background descendant must not be aborted");

  releaseChild();
  const [result] = (await batch.resultsPromise).map(toResultJson);
  assert.equal(result.status, "completed");
});
