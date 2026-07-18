import { readFile, writeFile } from "node:fs/promises";

const file = new URL("../src/domain/identifier-word-lists.ts", import.meta.url);
const listNames = [
  "CONVERSATION_ID_ADJECTIVES",
  "CONVERSATION_ID_NOUNS",
  "RUN_ID_VERBS",
  "RUN_ID_ADVERBS",
];

const original = await readFile(file, "utf8");
let sortedSource = original;

for (const name of listNames) {
  const pattern = new RegExp(`(export const ${name} = \\[\\n)([\\s\\S]*?)(\\n\\] as const;)`);
  const match = sortedSource.match(pattern);
  if (!match) throw new Error(`Could not find ${name}.`);

  const words = [...match[2].matchAll(/"([a-z]+)"/g)].map((entry) => entry[1]).sort();
  const lines = [];
  for (let index = 0; index < words.length; index += 10) {
    lines.push(`  ${words.slice(index, index + 10).map((word) => `"${word}"`).join(", ")},`);
  }

  sortedSource = sortedSource.replace(pattern, `$1${lines.join("\n")}$3`);
}

if (process.argv.includes("--check")) {
  if (sortedSource !== original) {
    console.error("Identifier word lists are not sorted. Run npm run sort:identifier-words.");
    process.exitCode = 1;
  }
} else {
  await writeFile(file, sortedSource);
}
