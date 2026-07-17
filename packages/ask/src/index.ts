import type { ExtensionAPI, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

import { createDeadlineSignal } from "./deadline.js";
import {
  AskParamsSchema,
  buildAskResponse,
  normalizeAsk,
  parseAskReplayDetails,
  type AskAnswer,
  type AskParams,
  type AskToolDetails,
} from "./domain.js";
import { CHECKED_BOX, CHECKED_CIRCLE, EMPTY_BOX, EMPTY_CIRCLE } from "./glyphs.js";
import { launchQuestionnaire } from "./questionnaire.js";
import { askWithRpc } from "./rpc.js";
import {
  ASK_REPLAY_CUSTOM_TYPE,
  buildAskReplayMessage,
  resolveAskReplayTarget,
  rewriteAskContext,
} from "./session.js";

type AskRendererState = {
  callComponent?: Text;
  status?: "answered" | "settled";
  invalidate?: () => void;
};

type AskReplayState =
  | { status: "idle" | "prompting" }
  | { status: "dispatched"; details: ReturnType<typeof buildAskReplayMessage>["details"] };

function renderAskCall(args: AskParams, theme: Theme, state: AskRendererState): string {
  const questionColor = state.status === "answered" ? "text" : "muted";
  const title = `${theme.fg("toolTitle", "ask")} ${theme.fg(questionColor, args.question)}`;
  if (state.status) return title;

  const optionCount = args.options.length;
  const mode = args.allowMultiple === true ? "multi · " : "";
  const timeout = args.timeout !== undefined && args.timeout > 0
    ? ` · timeout:${formatTimeout(args.timeout)}`
    : "";
  return `${title}\n${theme.fg("muted", `╰ ${mode}options:${optionCount}${timeout}`)}`;
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs < 1000) return `${timeoutMs}ms`;
  const seconds = timeoutMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(2))}s`;
}

class AnsweredOptions implements Component {
  constructor(
    private readonly args: AskParams,
    private readonly answer: AskAnswer,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const selections = new Map(this.answer.selections.map(selection => [selection.option, selection]));
    const checkedGlyph = this.args.allowMultiple === true ? CHECKED_BOX : CHECKED_CIRCLE;
    const emptyGlyph = this.args.allowMultiple === true ? EMPTY_BOX : EMPTY_CIRCLE;
    const rows = this.args.options.map((option, index) => {
      const label = option.label.trim();
      const selection = selections.get(index);
      const comment = selection?.comment ? ` (${selection.comment})` : "";
      return {
        marker: this.theme.fg(selection ? "success" : "muted", selection ? checkedGlyph : emptyGlyph),
        text: this.theme.fg(selection ? "text" : "muted", `${label}${comment}`),
      };
    });
    if (this.answer.freeform) {
      rows.push({
        marker: this.theme.fg("success", checkedGlyph),
        text: this.theme.fg("text", this.answer.freeform),
      });
    }

    return rows.flatMap((row, index) => wrapAnsweredRow(
      `${index === 0 ? `${this.theme.fg("muted", "╰")} ` : "  "}${row.marker} `,
      row.text,
      width,
    ));
  }
}

function wrapAnsweredRow(prefix: string, text: string, width: number): string[] {
  const safeWidth = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1);
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= safeWidth) return wrapTextWithAnsi(`${prefix}${text}`, safeWidth);

  const wrapped = wrapTextWithAnsi(text, safeWidth - prefixWidth);
  const continuation = " ".repeat(prefixWidth);
  return wrapped.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

export default function askExtension(pi: ExtensionAPI) {
  let replayState: AskReplayState = { status: "idle" };
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
  pi.on("agent_settled", () => {
    if (replayState.status !== "dispatched") return;
    pi.events.emit("ask:reanswered", replayState.details);
    replayState = { status: "idle" };
  });
  pi.on("session_shutdown", () => {
    replayState = { status: "idle" };
    revisedAnswers.clear();
    rendererStates.clear();
  });
  pi.on("session_tree", async (event, ctx) => {
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

    replayState = { status: "prompting" };
    const deadline = createDeadlineSignal(undefined, resolution.ask.timeout, process.env);
    try {
      const answer = await launchQuestionnaire(ctx, resolution.ask, deadline.signal);
      if (!answer) return;
      const message = buildAskReplayMessage(resolution.toolCallId, answer);
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      applyRevision(message.details.toolCallId, message.details.answer);
      replayState = { status: "dispatched", details: message.details };
    } finally {
      deadline.dispose();
      if (replayState.status !== "dispatched") replayState = { status: "idle" };
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
      const params = normalizeAsk(rawParams as AskParams);
      if (!ctx.hasUI) return buildAskResponse(params, { status: "ui_unavailable" });

      const deadline = createDeadlineSignal(signal, params.timeout, process.env);
      try {
        const answer = ctx.mode === "tui"
          ? await launchQuestionnaire(ctx, params, deadline.signal)
          : await askWithRpc(ctx.ui, params, deadline.signal);
        if (answer === null) {
          if (deadline.timedOut) {
            const result = buildAskResponse(params, { status: "unanswered" });
            pi.events.emit("ask:unanswered", result.details);
            return result;
          }
          const result = buildAskResponse(params, { status: "cancelled" });
          pi.events.emit("ask:cancelled", result.details);
          return result;
        }

        const result = buildAskResponse(params, { status: "answered", answer });
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
      if (answer) return new AnsweredOptions(context.args, answer, theme);
      const text = result.content.find((item) => item.type === "text")?.text ?? "Ask completed.";
      const color = result.details?.status === "cancelled" || result.details?.status === "unanswered"
        ? "muted"
        : "text";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });
}
