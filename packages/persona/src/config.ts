import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { parse } from "yaml";
import type { Persona } from "./types.js";

const RESERVED_NAMES = new Set(["none", "off", "clear", "(none)"]);

interface PersonaDirectoryResult {
  personas: Map<string, Persona>;
  warnings: string[];
}

export class PersonaConfig {
  private constructor(
    private readonly personas: Map<string, Persona>,
    readonly warnings: readonly string[],
  ) {}

  static empty(): PersonaConfig {
    return new PersonaConfig(new Map(), []);
  }

  static load(globalDirectory: string, projectDirectory?: string): PersonaConfig {
    const global = this.readDirectory(globalDirectory);
    if (!projectDirectory) {
      return new PersonaConfig(global.personas, global.warnings);
    }

    const project = this.readDirectory(projectDirectory);
    return new PersonaConfig(
      new Map([...global.personas, ...project.personas]),
      [...global.warnings, ...project.warnings],
    );
  }

  get(name: string): Persona | undefined {
    return this.personas.get(name);
  }

  has(name: string): boolean {
    return this.personas.has(name);
  }

  list(): readonly Persona[] {
    return [...this.personas.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private static readPersona(path: string): { persona?: Persona; warning?: string } {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      return { warning: `Could not load ${path}: ${String(error)}` };
    }

    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) return { warning: `Could not load ${path}: expected YAML frontmatter` };

    let frontmatter: unknown;
    try {
      frontmatter = parse(match[1]);
    } catch (error) {
      return { warning: `Could not load ${path}: ${String(error)}` };
    }

    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
      return { warning: `Could not load ${path}: expected frontmatter fields` };
    }

    const fields = frontmatter as Record<string, unknown>;
    const name = typeof fields.name === "string" ? fields.name.trim() : "";
    const description = typeof fields.description === "string" ? fields.description.trim() : undefined;
    const instructions = match[2].trim();

    if (!name) return { warning: `Could not load ${path}: frontmatter name is required` };
    if (/[\r\n]/.test(name)) {
      return { warning: `Could not load ${path}: persona name must be a single line` };
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      return { warning: `Could not load ${path}: persona name "${name}" is reserved` };
    }
    if (!instructions) return { warning: `Could not load ${path}: persona instructions are empty` };

    return {
      persona: {
        name,
        ...(description ? { description } : {}),
        instructions,
        sourcePath: path,
      },
    };
  }

  private static readDirectory(directory: string): PersonaDirectoryResult {
    let filenames: string[];
    try {
      filenames = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { personas: new Map(), warnings: [] };
      }
      return {
        personas: new Map(),
        warnings: [`Could not load ${directory}: ${String(error)}`],
      };
    }

    const personas = new Map<string, Persona>();
    const warnings: string[] = [];
    for (const filename of filenames) {
      const path = join(directory, filename);
      const result = this.readPersona(path);
      if (result.warning) {
        warnings.push(result.warning);
        continue;
      }
      if (!result.persona) continue;

      const previous = personas.get(result.persona.name);
      if (previous) {
        warnings.push(
          `Duplicate persona "${result.persona.name}" in ${path}; overriding ${previous.sourcePath}`,
        );
      }
      personas.set(result.persona.name, result.persona);
    }

    return { personas, warnings };
  }
}
