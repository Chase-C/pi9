import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Persona } from "./types.js";

const PersonaToolParameters = Type.Object({
  action: StringEnum(["list", "set", "clear"] as const),
  persona: Type.Optional(
    Type.String({ description: "Persona name; required when action is set" }),
  ),
}, { additionalProperties: false });

interface PersonaToolOptions {
  getPersonas: () => readonly Persona[];
  getActiveName: () => string | undefined;
  select: (name: string | undefined, ctx: ExtensionContext) => void;
  communicate: (ctx: ExtensionContext) => void;
}

function formatPersonaList(personas: readonly Persona[], activeName: string | undefined): string {
  const active = `Active persona: ${activeName ?? "(none)"}`;
  if (personas.length === 0) return `${active}\n\nNo personas configured.`;

  const available = personas.map((persona) =>
    `- ${persona.name}${persona.description ? ` — ${persona.description}` : ""}`
  );
  return `${active}\n\nAvailable personas:\n${available.join("\n")}`;
}

export function registerPersonaTool(pi: ExtensionAPI, options: PersonaToolOptions): void {
  pi.registerTool({
    name: "persona",
    label: "Persona",
    description:
      "List, set, or clear the active persona — instructions that shape your voice, priorities, and approach, but never what is true or what you're permitted to do.",
    promptSnippet: "Adopt a persona suited to the work at hand",
    promptGuidelines: [
      "Set or clear a persona when asked, or when the work clearly matches a configured persona's specialty; mention the switch in one line rather than asking permission.",
      "Stay fully in the active persona until it's changed or cleared; conversation length is never a reason to drift back to default. On a persona change, follow the new persona completely and drop every instruction from the old one.",
      "Clear or switch personas on your own initiative when the work one served is genuinely done — finishing one task within ongoing work of the same kind doesn't count.",
    ],
    parameters: PersonaToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const suppliedPersona = params.persona?.trim();

      if (params.action === "list") {
        if (params.persona !== undefined) {
          throw new Error('persona must not be provided when action is "list"');
        }
        const personas = options.getPersonas();
        return {
          content: [{ type: "text" as const, text: formatPersonaList(personas, options.getActiveName()) }],
          details: { action: params.action, activeName: options.getActiveName() ?? null },
        };
      }

      if (params.action === "clear") {
        if (params.persona !== undefined) {
          throw new Error('persona must not be provided when action is "clear"');
        }
        const wasActive = options.getActiveName() !== undefined;
        options.select(undefined, ctx);
        options.communicate(ctx);
        return {
          content: [{
            type: "text" as const,
            text: wasActive ? "Persona cleared." : "No persona was active.",
          }],
          details: { action: params.action, activeName: null },
        };
      }

      if (!suppliedPersona) {
        throw new Error('persona is required when action is "set"');
      }

      const personas = options.getPersonas();
      if (!personas.some((persona) => persona.name === suppliedPersona)) {
        const available = personas.map((persona) => persona.name).join(", ") || "(none configured)";
        throw new Error(`Unknown persona "${suppliedPersona}". Available: ${available}`);
      }

      options.select(suppliedPersona, ctx);
      options.communicate(ctx);
      return {
        content: [{ type: "text" as const, text: `Persona changed to "${suppliedPersona}".` }],
        details: { action: params.action, activeName: suppliedPersona },
      };
    },
  });
}
