import type { AgentSnapshot } from "../domain/agent-snapshot.js";

interface SubagentGuardPi {
  on?(event: "session_before_switch" | "session_before_fork", handler: (event: unknown, ctx: SubagentGuardContext) => Promise<{ cancel: true } | undefined>): void;
}

interface SubagentGuardContext {
  hasUI?: boolean;
  ui?: {
    confirm?(title: string, message: string): Promise<boolean>;
  };
}

interface SubagentGuardManager {
  listSessions(): AgentSnapshot[];
}

export function registerSubagentSessionGuards(pi: SubagentGuardPi, manager: SubagentGuardManager): void {
  if (typeof pi.on !== "function") return;
  const guard = async (_event: unknown, ctx: SubagentGuardContext) => confirmWithActiveSubagents(ctx, manager);
  pi.on("session_before_switch", guard);
  pi.on("session_before_fork", guard);
}

export async function confirmWithActiveSubagents(
  ctx: SubagentGuardContext,
  manager: SubagentGuardManager,
): Promise<{ cancel: true } | undefined> {
  const active = manager.listSessions().filter(session => session.status.kind === "queued" || session.status.kind === "running");
  if (active.length === 0) return undefined;
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") return undefined;

  const ok = await ctx.ui.confirm(
    "Active subagents",
    `${formatActiveSummary(active)}\n\nChanging sessions will tear down this extension runtime. Continue anyway?`,
  );
  return ok ? undefined : { cancel: true };
}

function formatActiveSummary(active: AgentSnapshot[]): string {
  const shown = active.slice(0, 6).map(session => {
    const label = session.label ? ` (${session.label})` : "";
    return `- ${session.config.name}${label}: ${session.status.kind}`;
  });
  const overflow = active.length - shown.length;
  if (overflow > 0) shown.push(`- ... and ${overflow} more`);
  return `${active.length} subagent${active.length === 1 ? " is" : "s are"} still active:\n${shown.join("\n")}`;
}
