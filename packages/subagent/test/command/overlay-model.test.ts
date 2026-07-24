import { describe, expect, it } from "vitest";
import { filterAgents, projectConversations } from "../../src/command/overlay-model.js";
import { fakeAgent } from "../helpers/fake-agent.js";

describe("conversation projection", () => {
  it("keeps descendants whose parent was removed", () => {
    const child = fakeAgent({ conversationId: "child", parent: { conversationId: "removed", runId: "removed-run" } });
    expect(projectConversations([child])).toEqual([{ conversation: child, depth: 0 }]);
  });

  it("includes ancestors as context when a descendant matches", () => {
    const parent = fakeAgent({ conversationId: "parent", prompt: "parent task" });
    const child = fakeAgent({ conversationId: "child", parent: { conversationId: "parent", runId: "parent-run" }, prompt: "needle task" });

    const rows = projectConversations([parent, child], { mode: "tree", query: "needle" });

    expect(rows.map(row => [row.conversation.conversationId, row.depth, row.contextOnly])).toEqual([
      ["parent", 0, true],
      ["child", 1, undefined],
    ]);
  });

  it("projects classic connectors and continuous ancestor rails", () => {
    const root = fakeAgent({ conversationId: "root", createdAt: 1 });
    const branchA = fakeAgent({ conversationId: "branch-a", createdAt: 3, parent: { conversationId: "root", runId: "root-run" } });
    const leafA = fakeAgent({ conversationId: "leaf-a", createdAt: 4, parent: { conversationId: "branch-a", runId: "branch-run" } });
    const branchB = fakeAgent({ conversationId: "branch-b", createdAt: 2, parent: { conversationId: "root", runId: "root-run" } });

    const rows = projectConversations([root, branchA, leafA, branchB]);

    expect(rows.map(row => [row.conversation.conversationId, row.treePrefix, row.treeContinuation])).toEqual([
      ["root", undefined, undefined],
      ["branch-a", "├─ ", "│  "],
      ["leaf-a", "│  ╰─ ", "│     "],
      ["branch-b", "╰─ ", "   "],
    ]);
  });

  it("sorts roots and siblings newest first while preserving tree shape", () => {
    const olderRoot = fakeAgent({ conversationId: "older-root", createdAt: 1 });
    const olderChild = fakeAgent({ conversationId: "older-child", createdAt: 2, parent: { conversationId: "older-root", runId: "root-run" } });
    const newerChild = fakeAgent({ conversationId: "newer-child", createdAt: 3, parent: { conversationId: "older-root", runId: "root-run" } });
    const newerRoot = fakeAgent({ conversationId: "newer-root", createdAt: 4 });

    expect(projectConversations([olderRoot, olderChild, newerChild, newerRoot]).map(row => row.conversation.conversationId)).toEqual([
      "newer-root",
      "older-root",
      "newer-child",
      "older-child",
    ]);
    expect(projectConversations([olderRoot, newerRoot], { mode: "flat" }).map(row => row.conversation.conversationId)).toEqual([
      "newer-root",
      "older-root",
    ]);
  });

  it("treats later insertions as newer when timestamps are equal", () => {
    const first = fakeAgent({ conversationId: "first", createdAt: 1 });
    const second = fakeAgent({ conversationId: "second", createdAt: 1 });

    expect(projectConversations([first, second]).map(row => row.conversation.conversationId)).toEqual(["second", "first"]);
    expect(projectConversations([first, second], { mode: "flat" }).map(row => row.conversation.conversationId)).toEqual(["second", "first"]);
  });

  it("filters conversations using run identities and activity", () => {
    const first = fakeAgent({ conversationId: "first", runId: "run-alpha" });
    const second = fakeAgent({ conversationId: "second", messageSnippet: "reviewing authentication" });

    expect(projectConversations([first, second], { mode: "flat", query: "run-alpha" }).map(row => row.conversation)).toEqual([first]);
    expect(projectConversations([first, second], { mode: "flat", query: "authentication" }).map(row => row.conversation)).toEqual([second]);
  });
});

describe("agent filtering", () => {
  it("sorts agents by name without mutating the source list", () => {
    const agents = [
      { name: "writer", description: "Writes docs", source: "user" },
      { name: "analyst", description: "Analyzes code", source: "project" },
      { name: "reviewer", description: "Reviews code", source: "project" },
    ] as any;

    expect(filterAgents(agents, "").map(agent => agent.name)).toEqual(["analyst", "reviewer", "writer"]);
    expect(agents.map((agent: any) => agent.name)).toEqual(["writer", "analyst", "reviewer"]);
  });

  it("matches configuration fields", () => {
    const agents = [
      { name: "reviewer", description: "Reviews code", source: "project", skills: ["security"] },
      { name: "writer", description: "Writes docs", source: "user", skills: [] },
    ] as any;

    expect(filterAgents(agents, "security").map(agent => agent.name)).toEqual(["reviewer"]);
    expect(filterAgents(agents, "user").map(agent => agent.name)).toEqual(["writer"]);
  });
});
