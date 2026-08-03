import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { AskComponent } from "./component.js";
import type { DeadlineSignal } from "./deadline.js";
import type { Ask, AskAnswer } from "./domain.js";

interface QuestionnaireLaunchContext {
  ui: Pick<ExtensionUIContext, "custom">;
}

export async function launchQuestionnaire(
  ctx: QuestionnaireLaunchContext,
  params: Ask,
  deadline?: DeadlineSignal,
): Promise<AskAnswer | null> {
  let abortListener: (() => void) | undefined;
  try {
    const answer = await ctx.ui.custom<AskAnswer | null>((tui, theme, keybindings, done) => {
      const component = new AskComponent({
        ...params,
        tui,
        theme,
        keybindings,
        deadline,
        onSubmit: done,
        onCancel: () => done(null),
      });

      abortListener = () => component.cancel();
      if (deadline?.signal?.aborted) abortListener();
      else if (deadline?.signal) deadline.signal.addEventListener("abort", abortListener, { once: true });

      return component;
    });
    return answer ?? null;
  } finally {
    if (abortListener) deadline?.signal?.removeEventListener("abort", abortListener);
  }
}
