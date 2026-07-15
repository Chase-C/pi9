export const MAX_TIMEOUT_MS = 2_147_483_647;

type AskEnvironment = Readonly<{
  PI9_ASK_TIMEOUT_MS?: string;
}>;

export function resolveTimeoutMs(
  perCallTimeout: number | undefined,
  env: AskEnvironment,
): number | undefined {
  if (perCallTimeout !== undefined) {
    return Number.isFinite(perCallTimeout)
      && Number.isInteger(perCallTimeout)
      && perCallTimeout > 0
      && perCallTimeout <= MAX_TIMEOUT_MS
      ? perCallTimeout
      : undefined;
  }

  const envTimeout = env.PI9_ASK_TIMEOUT_MS;
  if (envTimeout === undefined || !/^\d+$/.test(envTimeout)) return undefined;

  const timeout = Number(envTimeout);
  return Number.isFinite(timeout)
    && Number.isInteger(timeout)
    && timeout > 0
    && timeout <= MAX_TIMEOUT_MS
    ? timeout
    : undefined;
}
