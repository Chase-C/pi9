import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { rewriteAskContext } from "./context.js";
import { launchQuestionnaire } from "./questionnaire.js";
import { renderAskReanswerMessage } from "./replay-renderer.js";
import { ASK_REPLAY_CUSTOM_TYPE, buildAskReplayMessage, resolveAskReplayTarget } from "./replay.js";
import { buildAnsweredResponse, buildCancelledResponse, buildUiUnavailableResponse } from "./response.js";
import { askWithRpc } from "./rpc.js";
import { AskParamsSchema } from "./schema.js";
import type { AskAnswer, AskParams, AskToolDetails } from "./types.js";
import { validateAskParams } from "./validation.js";

export default function askExtension(pi: ExtensionAPI) {
  let replayInProgress = false;
  let pendingReplay: ReturnType<typeof buildAskReplayMessage>["details"] | undefined;

  pi.on("context", (event) => ({ messages: rewriteIntegratedContext(event.messages) }));
  pi.on("agent_settled", () => {
    if (!pendingReplay) return;
    pi.events.emit("ask:reanswered", pendingReplay);
    pendingReplay = undefined;
    replayInProgress = false;
  });
  pi.on("session_shutdown", () => {
    pendingReplay = undefined;
    replayInProgress = false;
  });
  pi.registerMessageRenderer(ASK_REPLAY_CUSTOM_TYPE, renderAskReanswerMessage);
  pi.on("session_tree", async (event, ctx) => {
    if (ctx.mode !== "tui" || replayInProgress) return;

    const entries = ctx.sessionManager.getBranch();
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    if (event.summaryEntry) byId.set(event.summaryEntry.id, event.summaryEntry);
    const resolution = resolveAskReplayTarget(event, id => byId.get(id));
    if (resolution.status !== "resolved") {
      if (resolution.reason === "mixed-tools" || resolution.reason === "multiple-tool-calls" || resolution.reason === "invalid-arguments") {
        ctx.ui.notify("This Ask cannot be re-answered because its original tool call is mixed or invalid.", "warning");
      }
      return;
    }

    const source = byId.get(resolution.sourceEntryId);
    const call = source?.type === "message" && source.message.role === "assistant"
      ? source.message.content.find(item => item.type === "toolCall" && item.name === "ask")
      : undefined;
    if (!call || call.type !== "toolCall") return;

    replayInProgress = true;
    let dispatched = false;
    try {
      const answer = await launchQuestionnaire(ctx, resolution.params);
      if (!answer) return;
      const message = buildAskReplayMessage(call.id, resolution.params, answer);
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      pendingReplay = message.details;
      dispatched = true;
    } finally {
      if (!dispatched) replayInProgress = false;
    }
  });

  pi.registerTool<typeof AskParamsSchema, AskToolDetails>({
    name: "ask",
    label: "Ask",
    description: "Ask one focused question with optional choices, comments, multiple selection, and freeform input.",
    promptSnippet: "Ask the user a focused question when a decision is required",
    promptGuidelines: [
      "Use ask only when user input is required; ask one focused question per call.",
      "Offer concise, distinct options and enable freeform when choices may be incomplete.",
    ],
    parameters: AskParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = validateAskParams(rawParams as AskParams);
      if (!ctx.hasUI) return buildUiUnavailableResponse(params.question);

      let answer: AskAnswer | null | undefined = await launchQuestionnaire(ctx, params, signal);
      if (answer === undefined) answer = await askWithRpc(ctx.ui, params, signal);
      if (answer === null) {
        const result = buildCancelledResponse(params.question);
        pi.events.emit("ask:cancelled", result.details);
        return result;
      }

      const result = buildAnsweredResponse(params.question, answer);
      pi.events.emit("ask:answered", result.details);
      return result;
    },

    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `Ask: ${args.question}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content.find((item) => item.type === "text")?.text ?? "Ask completed.";
      return new Text(theme.fg(result.details?.status === "cancelled" ? "muted" : "text", text), 0, 0);
    },
  });
}

/** Adapt canonical tool details for the pruning module, then retain canonical details in the returned context. */
function rewriteIntegratedContext<T>(messages: readonly T[]): T[] {
  const compatible = structuredClone(messages) as any[];
  const canonicalDetails = new Map<string, unknown>();
  for (const message of compatible) {
    const details = message?.details as AskToolDetails | undefined;
    if (message?.toolName === "ask" && typeof message.toolCallId === "string" && message.details !== undefined) {
      canonicalDetails.set(message.toolCallId, structuredClone(message.details));
    }
    if (message?.toolName === "ask" && details?.status === "answered") {
      message.details = { cancelled: false, ...details.answer };
    }
  }
  const rewritten = rewriteAskContext(compatible);
  for (const message of rewritten as any[]) {
    if (message?.toolName === "ask" && typeof message.toolCallId === "string" && canonicalDetails.has(message.toolCallId)) {
      message.details = structuredClone(canonicalDetails.get(message.toolCallId));
    }
  }
  return rewritten;
}
