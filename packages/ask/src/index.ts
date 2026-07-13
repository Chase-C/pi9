import type { ExtensionAPI, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { rewriteAskContext } from "./context.js";
import { launchQuestionnaire } from "./questionnaire.js";
import { renderAskReanswerMessage } from "./replay-renderer.js";
import { ASK_REPLAY_CUSTOM_TYPE, buildAskReplayMessage, parseAskReplayDetails, resolveAskReplayTarget } from "./replay.js";
import { buildAnsweredResponse, buildCancelledResponse, buildUiUnavailableResponse } from "./response.js";
import { askWithRpc } from "./rpc.js";
import { AskParamsSchema } from "./schema.js";
import type { AskAnswer, AskParams, AskToolDetails } from "./types.js";
import { validateAskParams } from "./validation.js";

const TREE_EDITOR_GUARD = "\u200B";

const EMPTY_CIRCLE = "󰄰";
const CHECKED_CIRCLE = "󰄴";

type AskRendererState = {
  callComponent?: Text;
  settled?: boolean;
  answered?: boolean;
  invalidate?: () => void;
};

function renderAskCall(args: AskParams, theme: Theme, state: AskRendererState): string {
  const questionColor = state.answered === true ? "text" : "dim";
  const title = `${theme.fg("toolTitle", "ask")} ${theme.fg(questionColor, args.question)}`;
  return state.settled === true ? title : `${title}\n${theme.fg("dim", args.allowMultiple === true ? "multi" : "single")}`;
}

function renderAnsweredOptions(args: AskParams, answer: AskAnswer, theme: Theme): string {
  const selections = new Map(answer.selections.map(selection => [selection.label, selection]));
  const lines = (args.options ?? []).map(option => {
    const label = option.label.trim();
    const selection = selections.get(label);
    const description = option.description?.trim();
    const comment = selection?.comment ? ` (${selection.comment})` : "";
    const text = `${label}${description ? ` — ${description}` : ""}${comment}`;
    return selection
      ? `${theme.fg("success", CHECKED_CIRCLE)} ${theme.fg("text", text)}`
      : theme.fg("dim", `${EMPTY_CIRCLE} ${text}`);
  });
  if (answer.freeform) lines.push(`${theme.fg("success", CHECKED_CIRCLE)} ${theme.fg("text", answer.freeform)}`);
  return lines.map((line, index) => `${index === 0 ? `${theme.fg("dim", "╰")} ` : "  "}${line}`).join("\n");
}

export default function askExtension(pi: ExtensionAPI) {
  let replayInProgress = false;
  let replayTreeSelection = false;
  let pendingReplay: ReturnType<typeof buildAskReplayMessage>["details"] | undefined;
  const revisedAnswers = new Map<string, AskAnswer>();
  const rendererStates = new Map<string, AskRendererState>();

  const applyRevision = (toolCallId: string, answer: AskAnswer) => {
    revisedAnswers.set(toolCallId, answer);
    rendererStates.get(toolCallId)?.invalidate?.();
  };
  const restoreRevisions = (entries: readonly SessionEntry[]) => {
    revisedAnswers.clear();
    for (const entry of entries) {
      if (entry.type !== "custom_message" || entry.customType !== ASK_REPLAY_CUSTOM_TYPE) continue;
      const details = parseAskReplayDetails(entry.details);
      if (details) revisedAnswers.set(details.toolCallId, details.answer);
    }
    for (const state of rendererStates.values()) state.invalidate?.();
  };

  pi.on("session_start", (_event, ctx) => restoreRevisions(ctx.sessionManager.getBranch()));
  pi.on("context", (event) => ({ messages: rewriteAskContext(event.messages) }));
  pi.on("agent_settled", () => {
    if (!pendingReplay) return;
    pi.events.emit("ask:reanswered", pendingReplay);
    pendingReplay = undefined;
    replayInProgress = false;
  });
  pi.on("session_shutdown", () => {
    pendingReplay = undefined;
    replayInProgress = false;
    replayTreeSelection = false;
    revisedAnswers.clear();
    rendererStates.clear();
  });
  pi.registerMessageRenderer(ASK_REPLAY_CUSTOM_TYPE, renderAskReanswerMessage);
  pi.on("session_before_tree", (event, ctx) => {
    const target = ctx.sessionManager.getEntry(event.preparation.targetId);
    replayTreeSelection = target?.type === "custom_message" && target.customType === ASK_REPLAY_CUSTOM_TYPE;
  });
  pi.on("session_tree", async (event, ctx) => {
    const suppressEditorRestore = replayTreeSelection;
    replayTreeSelection = false;
    if (ctx.mode !== "tui" || replayInProgress) return;

    const entries = ctx.sessionManager.getBranch();
    restoreRevisions(entries);
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
      ? source.message.content.find(item => item.type === "toolCall" && item.id === resolution.toolCallId && item.name === "ask")
      : undefined;
    if (!call || call.type !== "toolCall") return;

    // Pi restores selected custom-message content after this hook returns. Keep
    // the editor temporarily non-empty, then remove the guard on the next tick.
    const guardEditor = suppressEditorRestore && !ctx.ui.getEditorText().trim();
    if (guardEditor) ctx.ui.setEditorText(TREE_EDITOR_GUARD);

    replayInProgress = true;
    let dispatched = false;
    try {
      const answer = await launchQuestionnaire(ctx, resolution.params);
      if (!answer) return;
      const message = buildAskReplayMessage(call.id, resolution.params, answer);
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      applyRevision(message.details.toolCallId, message.details.answer);
      pendingReplay = message.details;
      dispatched = true;
    } finally {
      if (!dispatched) replayInProgress = false;
      if (guardEditor) {
        setTimeout(() => {
          if (ctx.ui.getEditorText() === TREE_EDITOR_GUARD) ctx.ui.setEditorText("");
        }, 0);
      }
    }
  });

  pi.registerTool<typeof AskParamsSchema, AskToolDetails, AskRendererState>({
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

    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      context.state.callComponent = text;
      text.setText(renderAskCall(args, theme, context.state));
      return text;
    },
    renderResult(result, _options, theme, context) {
      context.state.invalidate = context.invalidate;
      rendererStates.set(context.toolCallId, context.state);
      const answer = revisedAnswers.get(context.toolCallId)
        ?? (result.details?.status === "answered" ? result.details.answer : undefined);
      context.state.settled = true;
      context.state.answered = answer !== undefined;
      context.state.callComponent?.setText(renderAskCall(context.args, theme, context.state));
      if (answer) return new Text(renderAnsweredOptions(context.args, answer, theme), 0, 0);
      const text = result.content.find((item) => item.type === "text")?.text ?? "Ask completed.";
      return new Text(theme.fg(result.details?.status === "cancelled" ? "muted" : "text", text), 0, 0);
    },
  });
}
