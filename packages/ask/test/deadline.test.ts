import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadlineSignal } from "../src/deadline.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
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
    const deadline = createDeadlineSignal(parent.signal, 1000);

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
    const deadline = createDeadlineSignal(undefined, 50);
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

  it.each([undefined, 0])("does not create a timer for timeout %s", (timeoutMs) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createDeadlineSignal(parent.signal, timeoutMs);

    expect(deadline.signal).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
    deadline.dispose();
  });

  it("disposes the timer and parent listener, preventing later abort", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createDeadlineSignal(parent.signal, 100);
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
