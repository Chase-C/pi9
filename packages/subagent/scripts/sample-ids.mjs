import { randomInt } from "node:crypto";
import { CONVERSATION_ID_ADJECTIVES, CONVERSATION_ID_NOUNS } from "../src/identifier-word-lists.ts";

const [countArgument = "10"] = process.argv.slice(2);
const count = Number(countArgument);
const combinations = CONVERSATION_ID_ADJECTIVES.flatMap((first) =>
  CONVERSATION_ID_NOUNS.map((second) => `${first}-${second}`),
);

if (!Number.isSafeInteger(count) || count < 1 || count > combinations.length) {
  console.error(`Count must be an integer between 1 and ${combinations.length}.`);
  process.exitCode = 1;
} else {
  for (let index = 0; index < count; index++) {
    const selected = randomInt(index, combinations.length);
    [combinations[index], combinations[selected]] = [combinations[selected], combinations[index]];
    console.log(combinations[index]);
  }
}
