import { RUN_ID_ADVERBS, RUN_ID_VERBS } from "../domain/identifier-word-lists.js";
import type { RunId } from "../domain/run-id.js";
import { IdAllocatorBase, type RandomIndex } from "./id-allocator-base.js";

/** Allocates unique run IDs for one owning runtime lifetime. */
export class RunIdAllocator extends IdAllocatorBase<RunId> {
  constructor(randomIndex?: RandomIndex) {
    super(RUN_ID_VERBS, RUN_ID_ADVERBS, randomIndex);
  }
}
