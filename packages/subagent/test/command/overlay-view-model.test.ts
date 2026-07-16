import { test } from "vitest";
import assert from "node:assert/strict";

import { filterAgents, projectSessions } from "../../src/command/overlay-view-model.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("agent filtering searches purpose and configuration metadata", () => {
  const agents = [
    { name: "reviewer", description: "Review authorization", source: "project", sourcePath: "/agents/reviewer.md", model: "sonnet", thinking: "high", tools: ["read"], skills: ["review"], resumable: true, systemPrompt: "" },
    { name: "builder", description: "Implement features", source: "user", tools: ["bash"], resumable: false, systemPrompt: "" },
  ] as any[];

  for (const query of ["authorization", "project", "sonnet", "read", "review"]) {
    assert.deepEqual(filterAgents(agents, query).map(agent => agent.name), ["reviewer"]);
  }
});

test("session filtering searches task identity and runtime metadata", () => {
  const sessions = [
    fakeAgent({ id: "root", label: "authorization", prompt: "Review tokens", dispatch: "background", retention: "persistent", status: { kind: "running" } }),
    fakeAgent({ id: "other", prompt: "Write docs" }),
  ];

  for (const query of ["authorization", "tokens", "background", "persistent", "running", "root"]) {
    assert.deepEqual(projectSessions(sessions, { mode: "flat", query }).map(row => row.session.id), ["root"]);
  }
});

test("flat session mode returns every matching session at depth zero", () => {
  const sessions = [
    fakeAgent({ id: "root", prompt: "Root task", status: { kind: "running" } }),
    fakeAgent({ id: "child", parentSessionId: "root", prompt: "Child task", status: { kind: "running" } }),
    fakeAgent({ id: "retained", parentSessionId: "root", prompt: "Retained task", retention: "persistent" }),
  ];

  assert.deepEqual(
    projectSessions(sessions, { mode: "flat", query: "" }).map(row => [row.session.id, row.depth]),
    [["root", 0], ["child", 0], ["retained", 0]],
  );
});

test("tree filtering retains non-matching ancestors as context for a running match", () => {
  const sessions = [
    fakeAgent({ id: "root", prompt: "Coordinate migration", status: { kind: "running" } }),
    fakeAgent({ id: "child", parentSessionId: "root", prompt: "Repair parser", status: { kind: "running" } }),
    fakeAgent({ id: "other", prompt: "Review docs", status: { kind: "running" } }),
  ];

  assert.deepEqual(
    projectSessions(sessions, { mode: "tree", query: "parser" }).map(row => [row.session.id, row.depth, row.contextOnly ?? false]),
    [["root", 0, true], ["child", 1, false]],
  );
});

test("tree session mode recursively nests only running descendants", () => {
  const sessions = [
    fakeAgent({ id: "root", status: { kind: "running" } }),
    fakeAgent({ id: "child", parentSessionId: "root", status: { kind: "running" } }),
    fakeAgent({ id: "grandchild", parentSessionId: "child", status: { kind: "running" } }),
    fakeAgent({ id: "queued", parentSessionId: "root", status: { kind: "queued" } }),
    fakeAgent({ id: "retained", parentSessionId: "root", retention: "persistent" }),
  ];

  assert.deepEqual(
    projectSessions(sessions, { mode: "tree", query: "" }).map(row => [row.session.id, row.depth]),
    [["root", 0], ["child", 1], ["grandchild", 2], ["queued", 0], ["retained", 0]],
  );
});
