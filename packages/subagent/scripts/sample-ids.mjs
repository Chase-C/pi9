import { randomInt } from "node:crypto";

import {
  CONVERSATION_ID_ADJECTIVES,
  CONVERSATION_ID_NOUNS,
  RUN_ID_ADVERBS,
  RUN_ID_VERBS,
} from "../src/domain/identifier-word-lists.ts";

const kinds = {
  conversationIds: [CONVERSATION_ID_ADJECTIVES, CONVERSATION_ID_NOUNS],
  runIds: [RUN_ID_VERBS, RUN_ID_ADVERBS],
};
const [kind, countArgument = "10"] = process.argv.slice(2);
const wordLists = kinds[kind];

if (!wordLists) {
  console.error("Usage: npm run sample:ids -- <runIds|conversationIds> [count]");
  process.exitCode = 1;
} else {
  const count = Number(countArgument);
  const combinations = wordLists[0].flatMap((first) =>
    wordLists[1].map((second) => `${first}-${second}`),
  );

  if (!Number.isSafeInteger(count) || count < 1 || count > combinations.length) {
    console.error(`Count must be an integer between 1 and ${combinations.length}.`);
    process.exitCode = 1;
  } else {
    for (let index = 0; index < count; index += 1) {
      const selected = randomInt(index, combinations.length);
      [combinations[index], combinations[selected]] = [combinations[selected], combinations[index]];
      console.log(combinations[index]);
    }
  }
}
