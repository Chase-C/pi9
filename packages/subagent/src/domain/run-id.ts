import { RUN_ID_ADVERBS, RUN_ID_VERBS } from "./identifier-word-lists.js";

declare const runIdBrand: unique symbol;
export type RunId = string & { readonly [runIdBrand]: true };

const verbs: ReadonlySet<string> = new Set(RUN_ID_VERBS);
const adverbs: ReadonlySet<string> = new Set(RUN_ID_ADVERBS);

/** Recognizes only IDs from the run verb-adverb namespace. */
export function isRunId(value: unknown): value is RunId {
  if (typeof value !== "string") return false;
  const words = value.split("-");
  return words.length === 2 && verbs.has(words[0]) && adverbs.has(words[1]);
}
