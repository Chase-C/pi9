import { expect, test } from "vitest";

import { fakeAgent, fakeGeneration } from "./fake-agent.js";

test("collection receipts and resume capability are independent fixture state", () => {
  const resumeCapable = fakeAgent({ resumeAllowed: true });
  expect(resumeCapable.generations.at(-1)?.receipts).toEqual({ user: false, model: false });
  expect(resumeCapable.resumeAllowed).toBe(true);

  const collected = fakeAgent({ receipts: { model: true } });
  expect(collected.generations.at(-1)?.receipts).toEqual({ user: false, model: true });
  expect(collected.resumeAllowed).toBe(false);
});

test("active conversations cannot allow resume, including supplied generations", () => {
  expect(() => fakeAgent({ status: { kind: "running" }, resumeAllowed: true })).toThrow(
    "An active fake conversation cannot allow resume.",
  );
  expect(() => fakeAgent({
    generations: [fakeGeneration({ status: { kind: "queued" } })],
    resumeAllowed: true,
  })).toThrow("An active fake conversation cannot allow resume.");
});
