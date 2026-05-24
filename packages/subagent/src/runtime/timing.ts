import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

export type TimingData = Record<string, unknown>;

const START = performance.now();
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function timingEnabled(): boolean {
  return ENABLED_VALUES.has((process.env.PI_SUBAGENT_DEBUG_TIMING ?? "").toLowerCase());
}

export function timingStart(event: string, data: TimingData = {}) {
  if (!timingEnabled()) return () => { };
  const start = performance.now();
  return (extra: TimingData = {}) => {
    emit(event, { ...data, ...extra, durationMs: performance.now() - start });
  };
}

export async function timingAsync<T>(event: string, data: TimingData, fn: () => Promise<T>): Promise<T> {
  if (!timingEnabled()) return fn();
  const end = timingStart(event, data);
  try {
    const result = await fn();
    end({ ok: true });
    return result;
  } catch (error) {
    end({ ok: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function emit(event: string, data: TimingData) {
  const line = `[subagent timing] +${formatNumber(performance.now() - START)}ms event=${event}${formatData(data)}`;
  const file = process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;
  if (file) {
    try {
      appendFileSync(file, `${line}\n`, "utf8");
      return;
    } catch { }
  }
  console.warn(line);
}

function formatData(data: TimingData) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "";
  return ` ${entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(" ")}`;
}

function formatValue(value: unknown): string {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatNumber(value: number): string {
  return value.toFixed(1);
}
