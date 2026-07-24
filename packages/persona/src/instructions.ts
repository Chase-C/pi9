import type { Persona } from "./types.js";

export const PERSONA_ACTIVATION_MESSAGE_TYPE = "persona-activation";
export const PERSONA_CHANGE_MESSAGE_TYPE = "persona-change";

const PERSONA_BASELINE_USAGE =
  "Follow the persona baseline below unless a later persona-change message supersedes it. The newest persona-change message is authoritative.";
const ACTIVATED_PERSONA_USAGE =
  "Follow the active persona below unless a later persona-change message supersedes it. The newest persona-change message is authoritative.";

export function appendPersonaBaseline(systemPrompt: string, persona: Persona): string {
  return `${systemPrompt}\n\n## Persona usage\n\n${PERSONA_BASELINE_USAGE}\n\n## Persona baseline: ${persona.name}\n\n${persona.instructions}`;
}

export function createPersonaActivationMessage(persona: Persona) {
  return {
    customType: PERSONA_ACTIVATION_MESSAGE_TYPE,
    content: `## Persona usage\n\n${ACTIVATED_PERSONA_USAGE}\n\n## Active persona: ${persona.name}\n\n${persona.instructions}`,
    display: false,
    details: { name: persona.name },
  } as const;
}

export function createPersonaChangeMessage(persona: Persona | undefined) {
  if (!persona) {
    return {
      customType: PERSONA_CHANGE_MESSAGE_TYPE,
      content: "Persona cleared. Stop following the previous persona instructions.",
      display: false,
      details: { name: null },
    } as const;
  }

  return {
    customType: PERSONA_CHANGE_MESSAGE_TYPE,
    content: `Persona changed to ${persona.name}. Follow these instructions until a newer persona-change message supersedes them.\n\n## Active persona: ${persona.name}\n\n${persona.instructions}`,
    display: false,
    details: { name: persona.name },
  } as const;
}
