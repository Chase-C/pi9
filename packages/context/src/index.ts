import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildContextReport } from "./builders.js";
import { createContextReportComponent } from "./component.js";
import type { ContextReport } from "./types.js";

async function showContextReport(ctx: ExtensionCommandContext, report: ContextReport): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/context requires interactive mode", "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _kb, done) =>
    createContextReportComponent(report, {
      theme,
      tui,
      onClose: () => done(undefined),
    }),
  );
}

export default function contextExtension(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Show context window usage and conversation stats",
    handler: async (_args, ctx) => {
      const report = buildContextReport(pi, ctx);
      if (!report) {
        ctx.ui.notify("Context usage is unavailable for the current model/session", "warning");
        return;
      }

      await showContextReport(ctx, report);
    },
  });
}
