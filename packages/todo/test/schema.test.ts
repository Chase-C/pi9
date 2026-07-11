import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { TodoParamsSchema } from "../src/schema.js";

describe("TodoParamsSchema", () => {
  it("requires add batches with a phase and uses the supported status enum", () => {
    expect(Check(TodoParamsSchema, {
      action: "add", phase: "Build", tasks: [{ content: "Write tests", status: "in_progress" }],
    })).toBe(true);
    expect(Check(TodoParamsSchema, { action: "add", content: "Write tests", status: "in_progress" })).toBe(false);
    expect(Check(TodoParamsSchema, {
      action: "add", phase: "Build", tasks: [{ content: "Write tests", status: "doing" }],
    })).toBe(false);
    expect(Check(TodoParamsSchema, { action: "archive" })).toBe(false);
  });

  it("accepts flat and phased set shapes", () => {
    expect(Check(TodoParamsSchema, { action: "set", tasks: [{ content: "One" }] })).toBe(true);
    expect(Check(TodoParamsSchema, { action: "set", phases: [{ name: "Plan", tasks: [] }] })).toBe(true);
  });
});
