import { describe, expect, it } from "vitest";
import { MAX_TIMEOUT_MS, resolveTimeoutMs } from "../src/config.js";

describe("resolveTimeoutMs", () => {
  it("gives an explicit per-call timeout precedence over the environment", () => {
    expect(resolveTimeoutMs(1250, { PI9_ASK_TIMEOUT_MS: "9000" })).toBe(1250);
    expect(resolveTimeoutMs(0, { PI9_ASK_TIMEOUT_MS: "9000" })).toBeUndefined();
    expect(resolveTimeoutMs(-1, { PI9_ASK_TIMEOUT_MS: "9000" })).toBeUndefined();
    expect(resolveTimeoutMs(1.5, { PI9_ASK_TIMEOUT_MS: "9000" })).toBeUndefined();
    expect(resolveTimeoutMs(Number.POSITIVE_INFINITY, { PI9_ASK_TIMEOUT_MS: "9000" })).toBeUndefined();
  });

  it("accepts the maximum per-call timeout and rejects larger values", () => {
    expect(resolveTimeoutMs(MAX_TIMEOUT_MS, { PI9_ASK_TIMEOUT_MS: "9000" })).toBe(MAX_TIMEOUT_MS);
    expect(resolveTimeoutMs(MAX_TIMEOUT_MS + 1, { PI9_ASK_TIMEOUT_MS: "9000" })).toBeUndefined();
  });

  it.each([
    ["1", 1],
    ["2500", 2500],
    [String(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS],
  ])("accepts a positive integer decimal environment value %s", (value, expected) => {
    expect(resolveTimeoutMs(undefined, { PI9_ASK_TIMEOUT_MS: value })).toBe(expected);
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
    expect(resolveTimeoutMs(undefined, { PI9_ASK_TIMEOUT_MS: value })).toBeUndefined();
  });
});
