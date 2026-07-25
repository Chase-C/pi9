import { describe, expect, it } from "vitest";
import {
  appendPersonaBaseline,
  createPersonaActivationMessage,
  createPersonaChangeMessage,
} from "../src/instructions.js";
import type { Persona } from "../src/types.js";

const planner: Persona = {
  name: "planner",
  description: "Plan before implementation",
  instructions: "Explore first and return a numbered implementation plan.",
  sourcePath: "/personas/planner.md",
};

describe("persona instructions", () => {
  it("appends usage guidance and the persona baseline to the system prompt", () => {
    expect(appendPersonaBaseline("Base prompt", planner)).toBe(
      "Base prompt\n\n## Persona usage\n\nFollow the persona baseline below unless a later persona-change message supersedes it. The newest persona-change message is authoritative.\n\n## Persona baseline: planner\n\nExplore first and return a numbered implementation plan.",
    );
  });

  it("creates a hidden first-activation message with persona usage guidance", () => {
    expect(createPersonaActivationMessage(planner)).toEqual({
      customType: "persona-activation",
      content:
        "## Persona usage\n\nFollow the active persona below unless a later persona-change message supersedes it. The newest persona-change message is authoritative.\n\n## Active persona: planner\n\nExplore first and return a numbered implementation plan.",
      display: false,
      details: { name: "planner" },
    });
  });

  it("creates a hidden message that activates a later persona", () => {
    expect(createPersonaChangeMessage(planner)).toEqual({
      customType: "persona-change",
      content:
        "Persona changed to planner. Follow these instructions until a newer persona-change message supersedes them.\n\n## Active persona: planner\n\nExplore first and return a numbered implementation plan.",
      display: false,
      details: { name: "planner" },
    });
  });

  it("creates a hidden message that clears a persona", () => {
    expect(createPersonaChangeMessage(undefined)).toEqual({
      customType: "persona-change",
      content: "Persona cleared. Stop following the previous persona instructions.",
      display: false,
      details: { name: null },
    });
  });
});
