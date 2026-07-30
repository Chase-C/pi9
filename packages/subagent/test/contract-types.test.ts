import { expectTypeOf, test } from "vitest";
import type {
  CanonicalLiveSubagent as PublicCanonicalLiveSubagent,
  SubagentBatchSummary,
  SubagentResponseEnvelope,
  SubagentResultsEnvelope,
  SubagentStatus,
} from "../src/index.js";
import {
  projectLiveSubagent,
  type CanonicalActiveSubagent,
  type CanonicalNonFailedSubagent,
  type CanonicalFailedSubagent,
  type CanonicalFinishedSubagent,
  type CanonicalLiveSubagent,
} from "../src/contract.js";

test("the package exports its canonical public contract types", () => {
  expectTypeOf<PublicCanonicalLiveSubagent>().toEqualTypeOf<CanonicalLiveSubagent>();
  expectTypeOf<ReturnType<typeof projectLiveSubagent>>().toEqualTypeOf<CanonicalLiveSubagent>();
  expectTypeOf<CanonicalLiveSubagent["status"]>().toEqualTypeOf<SubagentStatus>();
  expectTypeOf<CanonicalLiveSubagent["ok"]>().toEqualTypeOf<true>();
  expectTypeOf<SubagentResultsEnvelope<"list">["action"]>().toEqualTypeOf<"list">();
  expectTypeOf<NonNullable<SubagentResultsEnvelope<"spawn">["summary"]>>().toEqualTypeOf<SubagentBatchSummary>();
  expectTypeOf<SubagentResponseEnvelope>().toHaveProperty("action");
});

test("canonical subagent states encode lifecycle-specific fields", () => {
  expectTypeOf<CanonicalActiveSubagent["joined"]>().toEqualTypeOf<undefined>();
  expectTypeOf<CanonicalActiveSubagent["failure"]>().toEqualTypeOf<undefined>();
  expectTypeOf<CanonicalNonFailedSubagent["joined"]>().toEqualTypeOf<boolean>();
  expectTypeOf<CanonicalNonFailedSubagent["failure"]>().toEqualTypeOf<undefined>();
  expectTypeOf<CanonicalFailedSubagent["joined"]>().toEqualTypeOf<boolean>();
  expectTypeOf<CanonicalFailedSubagent["failure"]>().toEqualTypeOf<string>();
  expectTypeOf<CanonicalFinishedSubagent["status"]>().toEqualTypeOf<"completed" | "cancelled" | "failed">();
});
