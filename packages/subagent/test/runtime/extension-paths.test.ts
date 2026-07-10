import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverInheritedExtensionPaths } from "../../src/runtime/extension-paths.js";

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "extension-paths-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  return { agentDir, cwd };
}

test("discovers enabled inherited extension paths in stable deduplicated order", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const projectOne = join(cwd, ".pi", "extensions", "one.ts");
  const projectTwo = join(cwd, ".pi", "extensions", "two.ts");
  const disabled = join(cwd, ".pi", "extensions", "disabled.ts");
  const global = join(agentDir, "extensions", "global.ts");
  await writeFile(projectOne, "export default () => {};");
  await writeFile(projectTwo, "export default () => {};");
  await writeFile(disabled, "export default () => {};");
  await writeFile(global, "export default () => {};");
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
    extensions: ["extensions/one.ts", "!extensions/disabled.ts"],
  }));

  const paths = await discoverInheritedExtensionPaths(cwd, agentDir);

  assert.deepEqual(paths, [projectOne, projectTwo, global]);
});

test("excludes this package's extension entry through a symlink without excluding other extensions", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const selfLink = join(cwd, ".pi", "extensions", "self.ts");
  const other = join(cwd, ".pi", "extensions", "other.ts");
  const ownEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
  await symlink(ownEntry, selfLink);
  await writeFile(other, "export default () => {};");

  const paths = await discoverInheritedExtensionPaths(cwd, agentDir);

  assert.deepEqual(paths, [other]);
});
