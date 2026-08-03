import {
  DEFAULT_ASK_SETTINGS,
  type AskSettings,
} from "./settings.js";

export { MAX_TIMEOUT_MS } from "./settings.js";

export interface DeadlineSignal {
  signal: AbortSignal | undefined;
  readonly deadlineAt: number | undefined;
  readonly timedOut: boolean;
  handleInput(): boolean;
  dispose(): void;
}

export function resolveTimeoutMs(
  enabled: boolean | undefined,
  settings: Pick<AskSettings, "timeoutMs">,
): number | undefined {
  return enabled === true ? settings.timeoutMs : undefined;
}

export function createDeadlineSignal(
  parent: AbortSignal | undefined,
  enabled: boolean | undefined,
  settings: AskSettings = DEFAULT_ASK_SETTINGS,
): DeadlineSignal {
  const timeoutMs = resolveTimeoutMs(enabled, settings);

  if (parent === undefined && timeoutMs === undefined) {
    return {
      signal: undefined,
      deadlineAt: undefined,
      timedOut: false,
      handleInput: () => false,
      dispose() {},
    };
  }

  const controller = new AbortController();
  let deadlineAt: number | undefined;
  let disposed = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentListener: (() => void) | undefined;

  const clearDeadline = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    deadlineAt = undefined;
  };

  const cleanup = (): void => {
    clearDeadline();
    if (parent !== undefined && parentListener !== undefined) {
      parent.removeEventListener("abort", parentListener);
      parentListener = undefined;
    }
  };

  const abort = (reason?: unknown): void => {
    if (disposed || controller.signal.aborted) return;
    cleanup();
    controller.abort(reason);
  };

  const scheduleDeadline = (): void => {
    if (timeoutMs === undefined) return;
    clearDeadline();
    deadlineAt = Date.now() + timeoutMs;
    timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
  };

  if (parent?.aborted) {
    abort(parent.reason);
    return {
      signal: controller.signal,
      deadlineAt: undefined,
      timedOut: false,
      handleInput: () => false,
      dispose() {},
    };
  }

  if (parent !== undefined) {
    parentListener = () => abort(parent.reason);
    parent.addEventListener("abort", parentListener, { once: true });
  }

  scheduleDeadline();

  return {
    signal: controller.signal,
    get deadlineAt() {
      return deadlineAt;
    },
    get timedOut() {
      return timedOut;
    },
    handleInput() {
      if (disposed || controller.signal.aborted || timer === undefined) return false;
      if (settings.timeoutOnInput === "reset") scheduleDeadline();
      else if (settings.timeoutOnInput === "cancel") clearDeadline();
      else return false;
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
  };
}
