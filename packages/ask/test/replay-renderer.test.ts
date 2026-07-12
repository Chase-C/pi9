import { describe, expect, it } from "vitest";
import { Text } from "@earendil-works/pi-tui";

import { renderAskReanswerMessage } from "../src/replay-renderer.js";

const theme = { fg: (_color: string, text: string) => text };

function render(details: unknown, expanded: boolean, content = "fallback text"): string {
  const component = renderAskReanswerMessage(
    { content, details } as never,
    { expanded },
    theme as never,
  );
  expect(component).toBeInstanceOf(Text);
  return component.render(120).join("\n").trimEnd();
}

describe("ask revised-answer renderer", () => {
  const details = {
    status: "answered",
    question: "Which target should I use?",
    context: "Both targets pass the current test suite.",
    answer: {
      selections: [
        { label: "Staging", description: "Validate internally first", comment: "Safer rollout" },
        { label: "Production", description: "Release immediately" },
      ],
      freeform: "Start after the announcement.",
    },
  };

  it("renders a concise collapsed revised answer", () => {
    const rendered = render(details, false);

    expect(rendered).toContain("Revised answer");
    expect(rendered).toContain("Selected: Staging, Production");
    expect(rendered).toContain("Freeform: Start after the announcement.");
    expect(rendered).not.toContain("Which target should I use?");
    expect(rendered).not.toContain("Validate internally first");
    expect(rendered).not.toContain("Safer rollout");
  });

  it("renders question context and answer detail when expanded", () => {
    const rendered = render(details, true);

    expect(rendered).toContain("Revised answer");
    expect(rendered).toContain("Question: Which target should I use?");
    expect(rendered).toContain("Context: Both targets pass the current test suite.");
    expect(rendered).toContain("- Staging — Validate internally first (Safer rollout)");
    expect(rendered).toContain("- Production — Release immediately");
    expect(rendered).toContain("Freeform: Start after the announcement.");
  });

  it("falls back to textual message content for malformed details", () => {
    expect(() => render({ question: "Question", answer: { selections: "not an array" } }, false, "plain fallback")).not.toThrow();
    expect(render({ question: "Question", answer: { selections: "not an array" } }, false, "plain fallback")).toBe("plain fallback");
    expect(render({ question: "Question", answer: { selections: "not an array" } }, true, "plain fallback")).toBe("plain fallback");
  });
});
