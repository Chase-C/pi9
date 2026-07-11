import assert from "node:assert/strict";
import { test } from "vitest";

import { shouldRenderTodoAction } from "../src/visibility.js";

test("todo action visibility follows the selected policy", () => {
  const cases = [
    { visibility: "all" as const, action: "set", expected: true },
    { visibility: "all" as const, action: "add", expected: true },
    { visibility: "all" as const, action: "update", expected: true },
    { visibility: "all" as const, action: "remove", expected: true },
    { visibility: "all" as const, action: "view", expected: true },
    { visibility: "set-only" as const, action: "set", expected: true },
    { visibility: "set-only" as const, action: "add", expected: false },
    { visibility: "set-only" as const, action: "update", expected: false },
    { visibility: "set-only" as const, action: "remove", expected: false },
    { visibility: "set-only" as const, action: "view", expected: false },
    { visibility: "none" as const, action: "set", expected: false },
    { visibility: "none" as const, action: "add", expected: false },
    { visibility: "none" as const, action: "update", expected: false },
    { visibility: "none" as const, action: "remove", expected: false },
    { visibility: "none" as const, action: "view", expected: false },
  ];

  for (const { visibility, action, expected } of cases) {
    assert.equal(shouldRenderTodoAction(action, visibility), expected, `${visibility}: ${action}`);
  }
});

test("unknown or absent actions are hidden for every visibility mode", () => {
  for (const visibility of ["all", "set-only", "none"] as const) {
    assert.equal(shouldRenderTodoAction(undefined, visibility), false, `${visibility}: absent`);
    assert.equal(shouldRenderTodoAction("archive", visibility), false, `${visibility}: unknown`);
  }
});
