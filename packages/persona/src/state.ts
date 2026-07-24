import {
  PERSONA_ACTIVATION_MESSAGE_TYPE,
  PERSONA_CHANGE_MESSAGE_TYPE,
} from "./instructions.js";
import type { CycleDirection, PersonaStateSnapshot } from "./types.js";

export const PERSONA_STATE_ENTRY_TYPE = "persona-state";

export interface PersonaSessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

export class PersonaStateManager {
  private active: string | undefined;
  private baseline: string | undefined;

  get activeName(): string | undefined {
    return this.active;
  }

  get baselineName(): string | undefined {
    return this.baseline;
  }

  restore(
    entries: readonly PersonaSessionEntry[],
    availableNames: ReadonlySet<string>,
  ): string[] {
    let snapshot: PersonaStateSnapshot | undefined;
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "custom" || entry.customType !== PERSONA_STATE_ENTRY_TYPE) continue;
      snapshot = PersonaStateManager.parseSnapshot(entry.data);
      if (snapshot) break;
    }

    this.active = snapshot?.activeName ?? undefined;
    this.baseline = snapshot?.baselineName ?? undefined;

    const warnings: string[] = [];
    for (const name of new Set([this.active, this.baseline])) {
      if (!name || availableNames.has(name)) continue;
      if (name === this.active) this.active = undefined;
      if (name === this.baseline) this.baseline = undefined;
      warnings.push(`Persona "${name}" is no longer configured`);
    }
    return warnings;
  }

  select(name: string | undefined, conversationStarted: boolean): void {
    this.active = name;
    if (!conversationStarted) this.baseline = name;
  }

  rebase(): void {
    this.baseline = this.active;
  }

  cycle(
    names: readonly string[],
    direction: CycleDirection,
    conversationStarted: boolean,
  ): string | undefined {
    if (names.length === 0) return undefined;

    const currentIndex = this.active ? names.indexOf(this.active) : -1;
    const offset = direction === "next" ? 1 : -1;
    const nextIndex = currentIndex === -1
      ? direction === "next" ? 0 : names.length - 1
      : (currentIndex + offset + names.length) % names.length;
    const name = names[nextIndex];
    this.select(name, conversationStarted);
    return name;
  }

  personaContextEstablished(contextEntries: readonly PersonaSessionEntry[]): boolean {
    return this.baseline !== undefined || contextEntries.some(PersonaStateManager.isPersonaMessage);
  }

  communicatedName(contextEntries: readonly PersonaSessionEntry[]): string | undefined {
    for (const entry of [...contextEntries].reverse()) {
      if (!PersonaStateManager.isPersonaMessage(entry)) continue;
      const name = (entry.details as { name?: unknown } | undefined)?.name;
      return typeof name === "string" ? name : undefined;
    }
    return this.baseline;
  }

  snapshot(): PersonaStateSnapshot {
    return {
      activeName: this.active ?? null,
      baselineName: this.baseline ?? null,
    };
  }

  private static isPersonaMessage(entry: PersonaSessionEntry): boolean {
    return entry.type === "custom_message" && (
      entry.customType === PERSONA_ACTIVATION_MESSAGE_TYPE ||
      entry.customType === PERSONA_CHANGE_MESSAGE_TYPE
    );
  }

  private static parseSnapshot(value: unknown): PersonaStateSnapshot | undefined {
    if (!value || typeof value !== "object") return undefined;
    const state = value as Record<string, unknown>;
    const activeName = state.activeName;
    const baselineName = "baselineName" in state ? state.baselineName : state.initialName;
    if (activeName !== null && typeof activeName !== "string") return undefined;
    if (baselineName !== null && typeof baselineName !== "string") return undefined;
    return { activeName, baselineName };
  }
}
