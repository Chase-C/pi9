import { expect, test } from "vitest";

import { fakeAgent, fakeGeneration } from "./fake-agent.js";

test("joined and resume capability are independent fixture state", () => {
  const resumeCapable = fakeAgent({ resumeAllowed: true });
  expect(resumeCapable.generations.at(-1)?.joined).toBe(false);
  expect(resumeCapable.resumeAllowed).toBe(true);

  const joined = fakeAgent({ joined: true });
  expect(joined.generations.at(-1)?.joined).toBe(true);
  expect(joined.resumeAllowed).toBe(false);
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
