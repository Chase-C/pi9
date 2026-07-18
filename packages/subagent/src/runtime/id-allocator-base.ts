import { randomInt } from "node:crypto";

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
  ) { }

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
      this.fallbackIndex += 1;
      const candidate = `${first}-${second}`;
      if (this.allocated.has(candidate)) continue;
      this.allocated.add(candidate);
      return candidate as T;
    }
    return undefined;
  }

  private randomCandidate(): string {
    return `${this.firstWords[this.randomIndex(this.firstWords.length)]}-${this.secondWords[this.randomIndex(this.secondWords.length)]}`;
  }
}
