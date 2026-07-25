import { describe, expect, it } from "vitest";
import { PersonaStateManager } from "../src/state.js";

describe("PersonaStateManager", () => {
  it("makes a pre-conversation selection the active persona and prompt baseline", () => {
    const state = new PersonaStateManager();

    state.select("planner", false);

    expect(state.activeName).toBe("planner");
    expect(state.baselineName).toBe("planner");
    expect(state.snapshot()).toEqual({ activeName: "planner", baselineName: "planner" });
  });

  it("preserves the prompt baseline after conversation starts", () => {
    const state = new PersonaStateManager();
    state.select("planner", false);

    state.select("reviewer", true);

    expect(state.snapshot()).toEqual({ activeName: "reviewer", baselineName: "planner" });
  });

  it("promotes the active persona to the prompt baseline on rebase", () => {
    const state = new PersonaStateManager();
    state.select("planner", false);
    state.select("reviewer", true);

    state.rebase();

    expect(state.baselineName).toBe("reviewer");
    expect(state.snapshot()).toEqual({ activeName: "reviewer", baselineName: "reviewer" });
  });

  it("clears the prompt baseline when compaction occurs without an active persona", () => {
    const state = new PersonaStateManager();
    state.select("planner", false);
    state.select(undefined, true);

    state.rebase();

    expect(state.snapshot()).toEqual({ activeName: null, baselineName: null });
  });

  it("cycles through sorted names in both directions with wrapping", () => {
    const state = new PersonaStateManager();
    const names = ["planner", "reviewer"];

    expect(state.cycle(names, "next", false)).toBe("planner");
    expect(state.cycle(names, "next", false)).toBe("reviewer");
    expect(state.cycle(names, "next", false)).toBe("planner");
    expect(state.cycle(names, "previous", false)).toBe("reviewer");
  });

  it("distinguishes absent persona context from an activation message", () => {
    const state = new PersonaStateManager();
    const activation = [
      { type: "custom_message", customType: "persona-activation", details: { name: "planner" } },
    ];

    expect(state.personaContextEstablished([])).toBe(false);
    expect(state.personaContextEstablished(activation)).toBe(true);
    expect(state.communicatedName(activation)).toBe("planner");
  });

  it("reports the newest persona represented in active conversation context", () => {
    const state = new PersonaStateManager();
    state.select("planner", false);

    expect(state.communicatedName([])).toBe("planner");
    expect(
      state.communicatedName([
        { type: "custom_message", customType: "persona-change", details: { name: "reviewer" } },
      ]),
    ).toBe("reviewer");
    expect(
      state.communicatedName([
        { type: "custom_message", customType: "persona-change", details: { name: null } },
      ]),
    ).toBeUndefined();
  });

  it("clears unavailable restored names and reports each one once", () => {
    const state = new PersonaStateManager();

    const warnings = state.restore(
      [
        {
          type: "custom",
          customType: "persona-state",
          data: { activeName: "removed", baselineName: "removed" },
        },
      ],
      new Set(),
    );

    expect(state.snapshot()).toEqual({ activeName: null, baselineName: null });
    expect(warnings).toEqual(["Persona \"removed\" is no longer configured"]);
  });

  it("restores legacy initialName state while ignoring malformed entries", () => {
    const state = new PersonaStateManager();
    const warnings = state.restore(
      [
        {
          type: "custom",
          customType: "persona-state",
          data: { activeName: "planner", initialName: "planner" },
        },
        {
          type: "custom",
          customType: "persona-state",
          data: { activeName: 42, initialName: null },
        },
      ],
      new Set(["planner"]),
    );

    expect(state.snapshot()).toEqual({ activeName: "planner", baselineName: "planner" });
    expect(warnings).toEqual([]);
  });
});
