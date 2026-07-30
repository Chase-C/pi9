import type { SubagentAction } from "./schema.js";

export interface SubagentResultsEnvelope<A extends SubagentAction = SubagentAction, T = unknown> {
  readonly action: A;
  readonly results: readonly T[];
}

export interface SubagentErrorEnvelope {
  readonly action: SubagentAction | "unknown";
  readonly error: string;
}

export type SubagentResponseEnvelope<A extends SubagentAction = SubagentAction, T = unknown> =
  | SubagentResultsEnvelope<A, T>
  | SubagentErrorEnvelope;
