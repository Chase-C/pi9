import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" | "success" = "info",
) {
  if (!ctx.hasUI) return;
  try {
    ctx.ui?.notify?.(message, level as any);
  } catch { }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
