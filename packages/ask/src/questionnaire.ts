import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { AskComponent } from "./component.js";
import type { AskAnswer, ValidatedAskParams } from "./types.js";

interface QuestionnaireLaunchContext {
  mode: string;
  ui: Pick<ExtensionUIContext, "custom">;
}

export async function launchQuestionnaire(
  ctx: QuestionnaireLaunchContext,
  params: ValidatedAskParams,
  signal?: AbortSignal,
): Promise<AskAnswer | null | undefined> {
  if (ctx.mode !== "tui") return undefined;

  let abortListener: (() => void) | undefined;
  try {
    return await ctx.ui.custom<AskAnswer | null>((tui, theme, _keybindings, done) => {
      const component = new AskComponent({
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
    });
  } finally {
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}
