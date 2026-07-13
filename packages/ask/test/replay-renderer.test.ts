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

describe("ask replay renderer", () => {
  const details = {
    toolCallId: "call-1",
    question: "Which target should I use?",
    context: "Both targets pass the current test suite.",
    allowMultiple: false,
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
    const malformed = { toolCallId: "call-1", question: "Question", allowMultiple: false, answer: { selections: "not an array" } };
    expect(() => render(malformed, false, "plain fallback")).not.toThrow();
    expect(render(malformed, false, "plain fallback")).toBe("plain fallback");
    expect(render(malformed, true, "plain fallback")).toBe("plain fallback");
  });
});
