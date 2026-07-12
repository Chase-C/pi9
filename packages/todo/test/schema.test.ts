import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TodoParamsSchema } from "../src/schema.js";

describe("TodoParamsSchema", () => {
  it("uses one strict flat provider-compatible object", () => {
    expect(TodoParamsSchema.type).toBe("object");
    expect("anyOf" in TodoParamsSchema).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "set",
      phases: [{ name: "Build", tasks: ["Implement feature"] }],
    })).toBe(true);
    expect(Check(TodoParamsSchema, {
      action: "add",
      phases: [{ name: "Verify", tasks: ["Run integration tests"] }],
    })).toBe(true);
    expect(Check(TodoParamsSchema, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "completed" }],
    })).toBe(true);
    expect(Check(TodoParamsSchema, { action: "view", phase: "Build" })).toBe(true);
  });

  it("rejects unknown properties, actions, statuses, and task objects", () => {
    expect(Check(TodoParamsSchema, { action: "archive" })).toBe(false);
    expect(Check(TodoParamsSchema, { action: "view", unknown: true })).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "set",
      phases: [{ name: "Build", tasks: [42] }],
    })).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "transition",
      transitions: [{ phase: "Build", task: "Implement feature", status: "doing" }],
    })).toBe(false);
  });
});
