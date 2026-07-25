import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PersonaConfig } from "../src/config.js";

describe("PersonaConfig", () => {
  it("loads Markdown personas and lets project personas override them by frontmatter name", () => {
    const globalDirectory = mkdtempSync(join(tmpdir(), "pi9-persona-global-"));
    const projectDirectory = mkdtempSync(join(tmpdir(), "pi9-persona-project-"));
    writeFileSync(
      join(globalDirectory, "planner.md"),
      "---\nname: planner\ndescription: Plans before acting\n---\n\nGlobal planner",
    );
    writeFileSync(
      join(globalDirectory, "reviewer.md"),
      "---\nname: reviewer\ndescription: Find correctness issues\n---\n\nReview carefully",
    );
    writeFileSync(join(projectDirectory, "custom.md"), "---\nname: planner\n---\n\nProject planner");

    const config = PersonaConfig.load(globalDirectory, projectDirectory);

    expect(config.list()).toEqual([
      {
        name: "planner",
        instructions: "Project planner",
        sourcePath: join(projectDirectory, "custom.md"),
      },
      {
        name: "reviewer",
        description: "Find correctness issues",
        instructions: "Review carefully",
        sourcePath: join(globalDirectory, "reviewer.md"),
      },
    ]);
    expect(config.warnings).toEqual([]);
  });

  it("uses the alphabetically later file and warns about duplicate names in one directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi9-persona-duplicate-"));
    writeFileSync(join(directory, "a.md"), "---\nname: planner\n---\n\nFirst");
    writeFileSync(join(directory, "b.md"), "---\nname: planner\n---\n\nSecond");

    const config = PersonaConfig.load(directory);

    expect(config.get("planner")?.instructions).toBe("Second");
    expect(config.warnings).toEqual([
      `Duplicate persona "planner" in ${join(directory, "b.md")}; overriding ${join(directory, "a.md")}`,
    ]);
  });

  it("ignores missing directories and rejects malformed or reserved personas", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi9-persona-invalid-"));
    writeFileSync(join(directory, "missing-frontmatter.md"), "No frontmatter");
    writeFileSync(join(directory, "reserved.md"), "---\nname: none\n---\n\nCannot be selected");
    writeFileSync(join(directory, "prototype.md"), "---\nname: toString\n---\n\nA valid unusual name");

    const config = PersonaConfig.load("/missing/personas", directory);

    expect(config.list().map((persona) => persona.name)).toEqual(["toString"]);
    expect(config.get("toString")?.instructions).toBe("A valid unusual name");
    expect(config.warnings).toHaveLength(2);
  });
});
