export const MAX_TIMEOUT_MS = 2_147_483_647;

type AskEnvironment = Readonly<{
  PI9_ASK_TIMEOUT_MS?: string;
}>;

export interface DeadlineSignal {
  signal: AbortSignal | undefined;
  readonly timedOut: boolean;
  dispose(): void;
}

export function resolveTimeoutMs(
  perCallTimeout: number | undefined,
  env: AskEnvironment,
): number | undefined {
  if (perCallTimeout !== undefined) {
    return Number.isInteger(perCallTimeout) && perCallTimeout > 0 && perCallTimeout <= MAX_TIMEOUT_MS
      ? perCallTimeout
      : undefined;
  }

  const envTimeout = env.PI9_ASK_TIMEOUT_MS;
  if (envTimeout === undefined || !/^\d+$/.test(envTimeout)) return undefined;

  const timeout = Number(envTimeout);
  return Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_TIMEOUT_MS
    ? timeout
    : undefined;
}

export function createDeadlineSignal(
  parent: AbortSignal | undefined,
  perCallTimeout: number | undefined,
  env: AskEnvironment = {},
): DeadlineSignal {
  const timeoutMs = resolveTimeoutMs(perCallTimeout, env);
  const hasTimeout = timeoutMs !== undefined;

  if (parent === undefined && !hasTimeout) {
    return {
      signal: undefined,
      timedOut: false,
      dispose() {},
    };
  }

  const controller = new AbortController();
  let disposed = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentListener: (() => void) | undefined;

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
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

  if (parent?.aborted) {
    abort(parent.reason);
    return {
      signal: controller.signal,
      timedOut: false,
      dispose() {},
    };
  }

  if (parent !== undefined) {
    parentListener = () => abort(parent.reason);
    parent.addEventListener("abort", parentListener, { once: true });
  }

  if (hasTimeout) {
    timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
  };
}
