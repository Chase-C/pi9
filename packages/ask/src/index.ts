import type { ExtensionAPI, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { rewriteAskContext } from "./context.js";
import { resolveTimeoutMs } from "./config.js";
import { createDeadlineSignal } from "./deadline.js";
import { CHECKED_BOX, CHECKED_CIRCLE, EMPTY_BOX, EMPTY_CIRCLE } from "./glyphs.js";
import { launchQuestionnaire } from "./questionnaire.js";
import { renderAskReanswerMessage } from "./replay-renderer.js";
import { ASK_REPLAY_CUSTOM_TYPE, buildAskReplayMessage, parseAskReplayDetails, resolveAskReplayTarget } from "./replay.js";
import { buildAnsweredResponse, buildCancelledResponse, buildUiUnavailableResponse, buildUnansweredResponse } from "./response.js";
import { askWithRpc } from "./rpc.js";
import { AskParamsSchema } from "./schema.js";
import type { AskAnswer, AskParams, AskToolDetails } from "./types.js";
import { validateAskParams } from "./validation.js";

const TREE_EDITOR_GUARD = "\u200B";

type AskRendererState = {
  callComponent?: Text;
  status?: "answered" | "settled";
  invalidate?: () => void;
};

type AskReplayState =
  | { status: "idle" }
  | { status: "prompting" }
  | {
      status: "dispatched";
      details: ReturnType<typeof buildAskReplayMessage>["details"];
      clearEditor: boolean;
    };

function renderAskCall(args: AskParams, theme: Theme, state: AskRendererState): string {
  const questionColor = state.status === "answered" ? "text" : "dim";
  const title = `${theme.fg("toolTitle", "ask")} ${theme.fg(questionColor, args.question)}`;
  if (state.status) return title;

  const optionCount = args.options.length;
  const mode = args.allowMultiple === true ? "multi · " : "";
  const timeout = args.timeout !== undefined && args.timeout > 0
    ? ` · timeout:${formatTimeout(args.timeout)}`
    : "";
  return `${title}\n${theme.fg("dim", `╰ ${mode}options:${optionCount}${timeout}`)}`;
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs < 1000) return `${timeoutMs}ms`;
  const seconds = timeoutMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(2))}s`;
}

function renderAnsweredOptions(args: AskParams, answer: AskAnswer, theme: Theme): string {
  const selections = new Map(answer.selections.map(selection => [selection.label, selection]));
  const checkedGlyph = args.allowMultiple === true ? CHECKED_BOX : CHECKED_CIRCLE;
  const emptyGlyph = args.allowMultiple === true ? EMPTY_BOX : EMPTY_CIRCLE;
  const lines = args.options.map(option => {
    const label = option.label.trim();
    const selection = selections.get(label);
    const comment = selection?.comment ? ` (${selection.comment})` : "";
    const text = `${label}${comment}`;
    return selection
      ? `${theme.fg("success", checkedGlyph)} ${theme.fg("text", text)}`
      : theme.fg("dim", `${emptyGlyph} ${text}`);
  });
  if (answer.freeform) lines.push(`${theme.fg("success", checkedGlyph)} ${theme.fg("text", answer.freeform)}`);
  return lines.map((line, index) => `${index === 0 ? `${theme.fg("dim", "╰")} ` : "  "}${line}`).join("\n");
}

export default function askExtension(pi: ExtensionAPI) {
  let replayState: AskReplayState = { status: "idle" };
  let replayTreeSelection = false;
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

  const reconcileAskTool = (hasUI: boolean) => {
    if (hasUI) return;
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes("ask")) return;
    pi.setActiveTools(activeTools.filter(name => name !== "ask"));
  };

  pi.on("session_start", (_event, ctx) => {
    reconcileAskTool(ctx.hasUI);
    restoreRevisions(ctx.sessionManager.getBranch());
  });
  pi.on("before_agent_start", (_event, ctx) => reconcileAskTool(ctx.hasUI));
  pi.on("context", (event) => ({ messages: rewriteAskContext(event.messages) }));
  pi.on("agent_settled", (_event, ctx) => {
    if (replayState.status !== "dispatched") return;
    if (replayState.clearEditor) {
      replayState = { ...replayState, clearEditor: false };
      setTimeout(() => ctx.ui.setEditorText(""), 0);
    }
    pi.events.emit("ask:reanswered", replayState.details);
    replayState = { status: "idle" };
  });
  pi.on("session_shutdown", () => {
    replayState = { status: "idle" };
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
    if (ctx.mode !== "tui" || replayState.status !== "idle") return;

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

    // Pi restores selected custom-message content after this hook returns. Keep
    // the editor temporarily non-empty until the replay turn settles so the
    // selected marker text cannot replace the guard.
    const guardEditor = suppressEditorRestore && !ctx.ui.getEditorText().trim();
    if (guardEditor) ctx.ui.setEditorText(TREE_EDITOR_GUARD);

    replayState = { status: "prompting" };
    const deadline = createDeadlineSignal(
      undefined,
      resolveTimeoutMs(resolution.params.timeout, process.env),
    );
    try {
      const answer = await launchQuestionnaire(ctx, resolution.params, deadline.signal);
      if (!answer) return;
      const message = buildAskReplayMessage(resolution.toolCallId, resolution.params, answer);
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      applyRevision(message.details.toolCallId, message.details.answer);
      replayState = { status: "dispatched", details: message.details, clearEditor: guardEditor };
    } finally {
      deadline.dispose();
      if (replayState.status !== "dispatched") {
        replayState = { status: "idle" };
        if (guardEditor) setTimeout(() => ctx.ui.setEditorText(""), 0);
      }
    }
  });

  pi.registerTool<typeof AskParamsSchema, AskToolDetails, AskRendererState>({
    name: "ask",
    label: "Ask",
    description: "Ask the user one focused question with selectable options. Blocks until answered, cancelled, or timed out.",
    promptSnippet: "Ask the user a focused question with selectable options when input is required",
    promptGuidelines: [
      "Use ask only when you can offer a short list of useful options; put open-ended questions in your normal response instead.",
      "An ask_response is a completed ask whose tool call was removed from the context; treat its answer as final and do not re-ask.",
    ],
    parameters: AskParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = validateAskParams(rawParams as AskParams);
      if (!ctx.hasUI) return buildUiUnavailableResponse(params.question);

      const deadline = createDeadlineSignal(
        signal,
        resolveTimeoutMs(params.timeout, process.env),
      );
      try {
        const answer = ctx.mode === "tui"
          ? await launchQuestionnaire(ctx, params, deadline.signal)
          : await askWithRpc(ctx.ui, params, deadline.signal);
        if (answer === null) {
          if (deadline.timedOut) {
            const result = buildUnansweredResponse(params.question);
            pi.events.emit("ask:unanswered", result.details);
            return result;
          }
          const result = buildCancelledResponse(params.question);
          pi.events.emit("ask:cancelled", result.details);
          return result;
        }

        const result = buildAnsweredResponse(params.question, answer);
        pi.events.emit("ask:answered", result.details);
        return result;
      } finally {
        deadline.dispose();
      }
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
      context.state.status = answer === undefined ? "settled" : "answered";
      context.state.callComponent?.setText(renderAskCall(context.args, theme, context.state));
      if (answer) return new Text(renderAnsweredOptions(context.args, answer, theme), 0, 0);
      const text = result.content.find((item) => item.type === "text")?.text ?? "Ask completed.";
      const color = result.details?.status === "cancelled" || result.details?.status === "unanswered"
        ? "muted"
        : "text";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });
}
