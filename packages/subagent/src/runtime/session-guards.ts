import type { AgentSnapshot } from "../domain/agent-snapshot.js";
interface GuardPi { on?(event: "session_before_switch" | "session_before_fork", handler: (event: unknown, ctx: GuardContext) => Promise<{ cancel: true } | undefined>): void }
interface GuardContext { hasUI?: boolean; ui?: { confirm?(title: string, message: string): Promise<boolean> } }
interface GuardManager { listConversations(): AgentSnapshot[] }
export function registerSubagentSessionGuards(pi: GuardPi, manager: GuardManager): void { const guard = (_: unknown, ctx: GuardContext) => confirmWithActiveSubagents(ctx, manager); pi.on?.("session_before_switch", guard); pi.on?.("session_before_fork", guard); }
export async function confirmWithActiveSubagents(ctx: GuardContext, manager: GuardManager): Promise<{ cancel: true } | undefined> {
  const active = manager.listConversations().filter(item => item.currentRun?.status.kind === "queued" || item.currentRun?.status.kind === "running");
  if (!active.length || !ctx.hasUI || !ctx.ui?.confirm) return;
  const lines = active.slice(0, 6).map(item => `- ${item.config.name}${item.label ? ` (${item.label})` : ""}: ${item.currentRun!.status.kind}`);
  if (active.length > 6) lines.push(`- ... and ${active.length - 6} more`);
  const ok = await ctx.ui.confirm("Active subagents", `${active.length} subagent${active.length === 1 ? " is" : "s are"} still active:\n${lines.join("\n")}\n\nChanging sessions will tear down this extension runtime. Continue anyway?`);
  return ok ? undefined : { cancel: true };
}
