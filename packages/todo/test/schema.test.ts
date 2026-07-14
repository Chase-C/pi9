import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TodoParamsSchema } from "../src/schema.js";
import { describedTask } from "./helpers.js";

describe("TodoParamsSchema", () => {
  it("uses one strict flat provider-compatible object", () => {
    expect(TodoParamsSchema.type).toBe("object");
    expect("anyOf" in TodoParamsSchema).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "set",
      phases: [{ name: "Build", tasks: [describedTask("Implement feature")] }],
    })).toBe(true);
    expect(Check(TodoParamsSchema, {
      action: "add",
      phases: [{ name: "Verify", tasks: [describedTask("Run integration tests")] }],
    })).toBe(true);
    expect(Check(TodoParamsSchema, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "in_progress" }],
      workingOn: "Implementing the feature",
    })).toBe(true);
    expect(Check(TodoParamsSchema, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "completed" }],
    })).toBe(true);
    expect(Check(TodoParamsSchema, { action: "view" })).toBe(true);
  });

  it("rejects unknown properties, actions, statuses, and incomplete tasks", () => {
    expect(Check(TodoParamsSchema, { action: "archive" })).toBe(false);
    expect(Check(TodoParamsSchema, { action: "view", unknown: true })).toBe(false);
    expect(Check(TodoParamsSchema, { action: "view", phase: "Build" })).toBe(false);
    expect(Check(TodoParamsSchema, { action: "set", phases: [] })).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "set",
      phases: [{ name: "Build", tasks: [] }],
    })).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "set",
      phases: [{ name: "Build", tasks: [42] }],
    })).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "set",
      phases: [{ name: "Build", tasks: [{ name: "Missing description" }] }],
    })).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "doing" }],
    })).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "completed" }],
      workingOn: null,
    })).toBe(false);
  });
});
