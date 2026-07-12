import { expect, test } from "vitest";
import { shouldRenderTodoAction } from "../src/visibility.js";

test("todo action visibility follows the selected policy", () => {
  for (const item of [
    { visibility: "all" as const, action: "set", expected: true },
    { visibility: "all" as const, action: "add", expected: true },
    { visibility: "all" as const, action: "transition", expected: true },
    { visibility: "all" as const, action: "view", expected: true },
    { visibility: "set-only" as const, action: "set", expected: true },
    { visibility: "set-only" as const, action: "add", expected: false },
    { visibility: "set-only" as const, action: "transition", expected: false },
    { visibility: "set-only" as const, action: "view", expected: false },
    { visibility: "none" as const, action: "set", expected: false },
  ]) {
    expect(shouldRenderTodoAction(item.action, item.visibility)).toBe(item.expected);
  }
});

test("unknown or absent actions are hidden", () => {
  for (const visibility of ["all", "set-only", "none"] as const) {
    expect(shouldRenderTodoAction(undefined, visibility)).toBe(false);
    expect(shouldRenderTodoAction("archive", visibility)).toBe(false);
  }
});
