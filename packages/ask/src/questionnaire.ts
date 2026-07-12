import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { createAskComponent } from "./component.js";
import type { AskAnswer, ValidatedAskParams } from "./types.js";

/** Minimal execution context needed to launch the interactive questionnaire. */
export interface QuestionnaireLaunchContext {
  mode: string;
  ui: Pick<ExtensionUIContext, "custom">;
}

/**
 * Launch an ask questionnaire when the caller is running in TUI mode.
 *
 * Other modes return `undefined`, allowing the integration layer to decide
 * whether and how to provide a fallback.
 */
export async function launchQuestionnaire(
  ctx: QuestionnaireLaunchContext,
  params: ValidatedAskParams,
  signal?: AbortSignal,
): Promise<AskAnswer | null | undefined> {
  if (ctx.mode !== "tui") return undefined;

  let abortListener: (() => void) | undefined;
  try {
    return await ctx.ui.custom<AskAnswer | null>((tui, theme, _keybindings, done) => {
      const component = createAskComponent({
        tui,
        theme,
        ...params,
        onSubmit: done,
        onCancel: () => done(null),
      });

      abortListener = () => component.cancel();
      if (signal?.aborted) abortListener();
      else if (signal) signal.addEventListener("abort", abortListener, { once: true });

      return component;
    }, {
      overlay: true,
      overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%" },
    });
  } finally {
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}

export default launchQuestionnaire;
