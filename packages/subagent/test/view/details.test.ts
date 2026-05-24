import { test } from "vitest";
import assert from "node:assert/strict";

import { parseDetails } from "../../src/view/details.js";

test("parseDetails accepts a well-formed persisted inventory payload", () => {
  const parsed = parseDetails({ view: "inventory", sessions: [{ id: "s1" }] });

  assert.equal(parsed?.view, "inventory");
});

test("parseDetails rejects payloads without a recognized view tag", () => {
  assert.equal(parseDetails(undefined), undefined);
  assert.equal(parseDetails(42), undefined);
  assert.equal(parseDetails({ errors: ["task[0]: bad"] }), undefined);
  assert.equal(parseDetails({ view: "not-a-view", sessions: [] }), undefined);
});

test("parseDetails rejects a known view whose required field is missing or stale-shaped", () => {
  assert.equal(parseDetails({ view: "inventory" }), undefined);
  assert.equal(parseDetails({ view: "run-results", outcomes: [] }), undefined);
  assert.equal(parseDetails({ view: "run", group: { sessions: "not-an-array" } }), undefined);
});

test("parseDetails treats an error-result envelope as non-renderable", () => {
  assert.equal(parseDetails({ view: "error", errors: ["task[0]: bad"] }), undefined);
  assert.equal(parseDetails({ view: "error" }), undefined);
});
