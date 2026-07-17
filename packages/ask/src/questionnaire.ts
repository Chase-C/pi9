import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { AskComponent } from "./component.js";
import type { Ask, AskAnswer } from "./domain.js";

interface QuestionnaireLaunchContext {
  ui: Pick<ExtensionUIContext, "custom">;
}

export async function launchQuestionnaire(
  ctx: QuestionnaireLaunchContext,
  params: Ask,
  signal?: AbortSignal,
): Promise<AskAnswer | null> {
  let abortListener: (() => void) | undefined;
  try {
    const answer = await ctx.ui.custom<AskAnswer | null>((tui, theme, keybindings, done) => {
      const component = new AskComponent({
        ...params,
        tui,
        theme,
        keybindings,
        onSubmit: done,
        onCancel: () => done(null),
      });

      abortListener = () => component.cancel();
      if (signal?.aborted) abortListener();
      else if (signal) signal.addEventListener("abort", abortListener, { once: true });

      return component;
    });
    return answer ?? null;
  } finally {
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}
