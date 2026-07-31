import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TIMEOUT_MS,
  createDeadlineSignal,
  resolveTimeoutMs,
} from "../src/deadline.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("resolveTimeoutMs", () => {
  it.each([undefined, false])("disables the configured timeout when the flag is %s", (enabled) => {
    expect(resolveTimeoutMs(enabled, { PI9_ASK_TIMEOUT_MS: "9000" })).toBeUndefined();
  });

  it.each([
    ["1", 1],
    ["2500", 2500],
    [String(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS],
  ])("accepts a positive integer decimal environment value %s when enabled", (value, expected) => {
    expect(resolveTimeoutMs(true, { PI9_ASK_TIMEOUT_MS: value })).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "0",
    "-1",
    "1.5",
    "1e3",
    " 1000 ",
    "abc",
    "Infinity",
    String(MAX_TIMEOUT_MS + 1),
  ])("disables timeout for invalid environment value %s", (value) => {
    expect(resolveTimeoutMs(true, { PI9_ASK_TIMEOUT_MS: value })).toBeUndefined();
  });
});

describe("createDeadlineSignal", () => {
  it("returns an undefined signal and no-op disposer without a parent or timeout", () => {
    const deadline = createDeadlineSignal(undefined, undefined);

    expect(deadline.signal).toBeUndefined();
    expect(deadline.timedOut).toBe(false);
    expect(() => deadline.dispose()).not.toThrow();
  });

  it("returns an already-aborted signal when the parent is already aborted", () => {
    const parent = new AbortController();
    const reason = new Error("cancelled");
    parent.abort(reason);

    vi.useFakeTimers();
    const deadline = createDeadlineSignal(parent.signal, true, { PI9_ASK_TIMEOUT_MS: "1000" });

    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.signal?.reason).toBe(reason);
    expect(deadline.timedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    deadline.dispose();
  });

  it("propagates the parent abort exactly once", () => {
    const parent = new AbortController();
    const deadline = createDeadlineSignal(parent.signal, undefined);
    const onAbort = vi.fn();
    deadline.signal?.addEventListener("abort", onAbort);

    const reason = new Error("cancelled");
    parent.abort(reason);
    parent.abort(new Error("ignored"));

    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.signal?.reason).toBe(reason);
    expect(deadline.timedOut).toBe(false);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("aborts exactly once when a positive timeout expires", () => {
    vi.useFakeTimers();
    const deadline = createDeadlineSignal(undefined, true, { PI9_ASK_TIMEOUT_MS: "50" });
    const onAbort = vi.fn();
    deadline.signal?.addEventListener("abort", onAbort);

    vi.advanceTimersByTime(49);
    expect(deadline.signal?.aborted).toBe(false);
    expect(deadline.timedOut).toBe(false);

    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(100);

    expect(deadline.signal?.aborted).toBe(true);
    expect(deadline.timedOut).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, false])("does not create a timer when the flag is %s", (enabled) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createDeadlineSignal(parent.signal, enabled, { PI9_ASK_TIMEOUT_MS: "50" });

    expect(deadline.signal).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
    deadline.dispose();
  });

  it("disposes the timer and parent listener, preventing later abort", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createDeadlineSignal(parent.signal, true, { PI9_ASK_TIMEOUT_MS: "100" });
    const onAbort = vi.fn();
    deadline.signal?.addEventListener("abort", onAbort);

    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);

    parent.abort();
    vi.advanceTimersByTime(100);

    expect(deadline.signal?.aborted).toBe(false);
    expect(deadline.timedOut).toBe(false);
    expect(onAbort).not.toHaveBeenCalled();

    deadline.dispose();
  });
});
