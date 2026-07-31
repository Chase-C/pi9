import { randomInt } from "node:crypto";
import { CONVERSATION_ID_ADJECTIVES, CONVERSATION_ID_NOUNS } from "./identifier-word-lists.js";

declare const conversationIdBrand: unique symbol;
export type ConversationId = string & { readonly [conversationIdBrand]: true };
export type SubagentId = ConversationId;

const adjectives: ReadonlySet<string> = new Set(CONVERSATION_ID_ADJECTIVES);
const nouns: ReadonlySet<string> = new Set(CONVERSATION_ID_NOUNS);

/** Recognizes only IDs from the conversation adjective-noun namespace. */
export function isConversationId(value: unknown): value is ConversationId {
  if (typeof value !== "string") return false;
  const words = value.split("-");
  return words.length === 2 && adjectives.has(words[0]) && nouns.has(words[1]);
}

export const isSubagentId = isConversationId;

const RANDOM_RETRIES = 32;
export type RandomIndex = (max: number) => number;

/** Finite two-word allocator with bounded random retries and deterministic exhaustion. */
export class IdAllocatorBase<T extends string> {
  private readonly allocated = new Set<string>();
  private fallbackIndex = 0;

  constructor(
    private readonly firstWords: readonly string[],
    private readonly secondWords: readonly string[],
    private readonly randomIndex: RandomIndex = randomInt,
  ) {}

  allocate(): T | undefined {
    for (let attempt = 0; attempt < RANDOM_RETRIES; attempt++) {
      const candidate = this.randomCandidate();
      if (this.allocated.has(candidate)) continue;
      this.allocated.add(candidate);
      return candidate as T;
    }
    while (this.fallbackIndex < this.firstWords.length * this.secondWords.length) {
      const first = this.firstWords[Math.floor(this.fallbackIndex / this.secondWords.length)];
      const second = this.secondWords[this.fallbackIndex % this.secondWords.length];
      this.fallbackIndex++;
      const candidate = `${first}-${second}`;
      if (this.allocated.has(candidate)) continue;
      this.allocated.add(candidate);
      return candidate as T;
    }
  }

  private randomCandidate(): string {
    return `${this.firstWords[this.randomIndex(this.firstWords.length)]}-${this.secondWords[this.randomIndex(this.secondWords.length)]}`;
  }
}

/** Allocates unique conversation IDs for one owning runtime lifetime. */
export class ConversationIdAllocator extends IdAllocatorBase<ConversationId> {
  constructor(randomIndex?: RandomIndex) { super(CONVERSATION_ID_ADJECTIVES, CONVERSATION_ID_NOUNS, randomIndex); }
}
