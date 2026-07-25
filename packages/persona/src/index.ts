import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PersonaConfig } from "./config.js";
import {
  appendPersonaBaseline,
  createPersonaActivationMessage,
  createPersonaChangeMessage,
} from "./instructions.js";
import { PERSONA_STATE_ENTRY_TYPE, PersonaStateManager } from "./state.js";
import { registerPersonaTool } from "./tool.js";
import type { CycleDirection } from "./types.js";

const CLEAR_PERSONA_NAMES = new Set(["none", "off", "clear", "(none)"]);

function hasConversation(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) =>
    ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type),
  );
}

export default function personaExtension(pi: ExtensionAPI): void {
  let config = PersonaConfig.empty();
  const state = new PersonaStateManager();

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "persona",
      state.activeName ? ctx.ui.theme.fg("accent", `persona:${state.activeName}`) : undefined,
    );
  }

  function persistState(): void {
    pi.appendEntry(PERSONA_STATE_ENTRY_TYPE, state.snapshot());
  }

  function applySelection(name: string | undefined, ctx: ExtensionContext): void {
    state.select(name, hasConversation(ctx));
    persistState();
    updateStatus(ctx);
  }

  function selectPersona(name: string | undefined, ctx: ExtensionContext): boolean {
    const clearing = name === undefined || CLEAR_PERSONA_NAMES.has(name.toLowerCase());
    if (!clearing && !config.has(name)) return false;

    applySelection(clearing ? undefined : name, ctx);
    return true;
  }

  function communicatePersona(ctx: ExtensionContext): void {
    const contextEntries = ctx.sessionManager.buildContextEntries();
    const activePersona = state.activeName ? config.get(state.activeName) : undefined;
    const communicatedName = state.communicatedName(contextEntries);
    const contextEstablished = state.personaContextEstablished(contextEntries);
    const message = communicatedName === state.activeName
      ? undefined
      : !contextEstablished && activePersona
        ? createPersonaActivationMessage(activePersona)
        : createPersonaChangeMessage(activePersona);

    if (message) pi.sendMessage<{ name: string | null }>(message);
  }

  function notifySelection(ctx: ExtensionContext): void {
    ctx.ui.notify(
      state.activeName ? `Persona "${state.activeName}" activated` : "Persona cleared",
      "info",
    );
  }

  async function cyclePersona(direction: CycleDirection, ctx: ExtensionContext): Promise<void> {
    const name = state.cycle(
      config.list().map((persona) => persona.name),
      direction,
      hasConversation(ctx),
    );
    if (!name) {
      ctx.ui.notify("No personas configured", "warning");
      return;
    }

    persistState();
    updateStatus(ctx);
    notifySelection(ctx);
  }

  registerPersonaTool(pi, {
    getPersonas: () => config.list(),
    getActiveName: () => state.activeName,
    select: applySelection,
    communicate: communicatePersona,
  });

  pi.registerCommand("persona", {
    description: "Switch the active agent persona",
    getArgumentCompletions: (prefix) => {
      const names = ["none", ...config.list().map((persona) => persona.name)];
      const matches = names.filter((name) => name.startsWith(prefix));
      return matches.length > 0
        ? matches.map((name) => {
            const description = config.get(name)?.description;
            return { value: name, label: name, ...(description ? { description } : {}) };
          })
        : null;
    },
    handler: async (args, ctx) => {
      const requestedName = args.trim();
      if (requestedName) {
        if (!selectPersona(requestedName, ctx)) {
          const available = config.list().map((persona) => persona.name).join(", ") || "(none configured)";
          ctx.ui.notify(`Unknown persona "${requestedName}". Available: ${available}`, "error");
          return;
        }
        notifySelection(ctx);
        return;
      }

      const available = config.list();
      if (available.length === 0) {
        ctx.ui.notify("No personas configured", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(`Available personas: ${available.map((persona) => persona.name).join(", ")}`, "info");
        return;
      }

      const labels = [
        "(none)",
        ...available.map((persona) =>
          persona.description ? `${persona.name} — ${persona.description}` : persona.name,
        ),
      ];
      const choice = await ctx.ui.select("Select persona", labels);
      if (!choice) return;
      const selectedName = choice === "(none)" ? choice : available[labels.indexOf(choice) - 1]?.name;
      selectPersona(selectedName, ctx);
      notifySelection(ctx);
    },
  });

  pi.registerShortcut("alt+[", {
    description: "Cycle to the previous persona",
    handler: async (ctx) => cyclePersona("previous", ctx),
  });

  pi.registerShortcut("alt+]", {
    description: "Cycle to the next persona",
    handler: async (ctx) => cyclePersona("next", ctx),
  });

  pi.on("before_agent_start", (event, ctx) => {
    communicatePersona(ctx);
    const baselinePersona = state.baselineName ? config.get(state.baselineName) : undefined;
    if (!baselinePersona) return;
    return {
      systemPrompt: appendPersonaBaseline(event.systemPrompt, baselinePersona),
    };
  });

  pi.on("session_compact", () => {
    state.rebase();
    persistState();
  });

  pi.on("session_start", (_event, ctx) => {
    config = PersonaConfig.load(
      join(getAgentDir(), "personas"),
      ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "personas") : undefined,
    );
    for (const warning of config.warnings) ctx.ui.notify(warning, "warning");

    const availableNames = new Set(config.list().map((persona) => persona.name));
    const stateWarnings = state.restore(ctx.sessionManager.getBranch(), availableNames);
    for (const warning of stateWarnings) ctx.ui.notify(warning, "warning");
    updateStatus(ctx);
  });
}
