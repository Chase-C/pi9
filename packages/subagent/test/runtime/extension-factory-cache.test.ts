import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtensionFactoryCache, type ExtensionFactoryCacheOptions } from "../../src/runtime/extension-factory-cache.js";

const SAVED_TIMING = process.env.PI_SUBAGENT_DEBUG_TIMING;
const SAVED_TIMING_FILE = process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;

afterEach(() => {
  if (SAVED_TIMING === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING;
  else process.env.PI_SUBAGENT_DEBUG_TIMING = SAVED_TIMING;
  if (SAVED_TIMING_FILE === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;
  else process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = SAVED_TIMING_FILE;
});

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "ext-cache-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  return { root, agentDir, cwd };
}

function cacheWithPaths(
  paths: string[],
  options: Omit<ExtensionFactoryCacheOptions, "discoverPaths"> = {},
): ExtensionFactoryCache {
  return new ExtensionFactoryCache({ ...options, discoverPaths: async () => paths });
}

test("uses injected discovery paths when loading factories", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "outside-standard-roots.ts");
  await writeFile(entry, "export default () => {};");

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    discoverPaths: async (actualCwd, actualAgentDir) => {
      assert.equal(actualCwd, cwd);
      assert.equal(actualAgentDir, agentDir);
      return [entry];
    },
    importFactory: async (path: string) => { imported.push(path); return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.deepEqual(imported, [entry]);
  assert.equal(result.factories.length, 1);
  assert.deepEqual(result.fallbackPaths, []);
});

test("emits coarse discover and import spans but no per-entry marks when PI_SUBAGENT_DEBUG_TIMING is enabled", async () => {
  const { root, agentDir, cwd } = await makeWorkspace();
  const logFile = join(root, "timing.log");
  process.env.PI_SUBAGENT_DEBUG_TIMING = "1";
  process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = logFile;

  const okEntry = join(agentDir, "extensions", "ok.ts");
  const badEntry = join(agentDir, "extensions", "bad.ts");
  await writeFile(okEntry, "export default () => {};");
  await writeFile(badEntry, "export default () => {};");
  const invalidEntry = join(agentDir, "extensions", "invalid.ts");
  await writeFile(invalidEntry, "export const value = 1;");
  const removedEntry = join(agentDir, "extensions", "removed.ts");
  await writeFile(removedEntry, "export default () => {};");

  let calls = 0;
  const discovered = [okEntry, badEntry, invalidEntry, removedEntry];
  const cache = cacheWithPaths(discovered, {
    importFactory: async (p: string) => {
      calls += 1;
      if (p === badEntry) {
        await rm(removedEntry);
        throw new Error("boom");
      }
      if (p === invalidEntry) return undefined;
      return () => {};
    },
  });
  await cache.load(cwd, agentDir);  // discovery + miss + import + fallback-on-error
  await cache.load(cwd, agentDir);  // hit + sticky fallback

  await writeFile(okEntry, "export default () => { /* v2 */ };");
  await utimes(okEntry, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  await cache.load(cwd, agentDir);  // invalidation + re-import

  const bypassCache = cacheWithPaths(discovered, { bypass: true });
  await bypassCache.load(cwd, agentDir);  // fallback-on-bypass

  const log = await readFile(logFile, "utf8");
  // The instrumentation is thinned to the two coarse, variable-cost spans.
  assert.match(log, /event=extensionFactoryCache\.discover\b/);
  assert.match(log, /event=extensionFactoryCache\.import\b/);
  // The per-entry control-flow marks are dropped.
  for (const dropped of [
    "extensionFactoryCache.hit",
    "extensionFactoryCache.miss",
    "extensionFactoryCache.fallbackOnError",
    "extensionFactoryCache.fallbackOnBypass",
    "extensionFactoryCache.invalidate",
    "extensionFactoryCache.invalidModule",
    "extensionFactoryCache.skip",
  ]) {
    assert.doesNotMatch(log, new RegExp(`event=${dropped}\\b`), `unexpected event ${dropped}`);
  }
  void calls;
  await rm(logFile, { force: true });
});

test("does not import extension paths disabled by Pi settings filters", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const enabled = join(cwd, ".pi", "extensions", "enabled.ts");
  const disabled = join(cwd, ".pi", "extensions", "disabled.ts");
  await writeFile(enabled, "export default () => {};");
  await writeFile(disabled, "export default () => {};");
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["!extensions/disabled.ts"] }));

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    importFactory: async (path: string) => { imported.push(path); return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.equal(result.factories.length, 1);
  assert.deepEqual(imported, [enabled]);
});

test("discovers enabled extension entries from local package manifests", async () => {
  const { root, agentDir, cwd } = await makeWorkspace();
  const packageDir = join(root, "package-extension");
  await mkdir(join(packageDir, "lib"), { recursive: true });
  const entry = join(packageDir, "lib", "extension.ts");
  await writeFile(entry, "export default () => {};");
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "package-extension", pi: { extensions: ["./lib/extension.ts"] } }),
  );
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["../../package-extension"] }));

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    importFactory: async (path: string) => { imported.push(path); return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.equal(result.factories.length, 1);
  assert.deepEqual(imported, [entry]);
});

test("discovers enabled extension entries from project settings", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(cwd, ".pi", "configured.ts");
  await writeFile(entry, "export default () => {};");
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["configured.ts"] }));

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    importFactory: async (path: string) => { imported.push(path); return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.equal(result.factories.length, 1);
  assert.deepEqual(imported, [entry]);
});

test("default importer loads real TS extension files and returns a fresh factory after the file changes", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "real.ts");
  await writeFile(entry, "export default (pi: any) => { pi.tag = 'v1'; };");

  const cache = cacheWithPaths([entry]);

  const first = await cache.load(cwd, agentDir);
  assert.equal(first.fallbackPaths.length, 0, "default importer should successfully import TS files");
  assert.equal(first.factories.length, 1);
  const probe1: any = {};
  await first.factories[0](probe1);
  assert.equal(probe1.tag, "v1");

  await writeFile(entry, "export default (pi: any) => { pi.tag = 'v2-updated'; };");
  await utimes(entry, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

  const second = await cache.load(cwd, agentDir);
  assert.equal(second.factories.length, 1);
  const probe2: any = {};
  await second.factories[0](probe2);
  assert.equal(probe2.tag, "v2-updated", "must not return stale module");
});

test("bypass mode routes every discovered path to fallback without invoking the importer", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const tsEntry = join(agentDir, "extensions", "alpha.ts");
  const jsEntry = join(cwd, ".pi", "extensions", "beta.js");
  await writeFile(tsEntry, "export default () => {};");
  await writeFile(jsEntry, "export default () => {};");

  let calls = 0;
  const cache = cacheWithPaths([tsEntry, jsEntry], {
    bypass: true,
    importFactory: async () => { calls += 1; return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.equal(calls, 0);
  assert.deepEqual(result.factories, []);
  assert.deepEqual([...result.fallbackPaths].sort(), [tsEntry, jsEntry].sort());
});

test("emits fallback path when importer throws", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "broken.ts");
  await writeFile(entry, "export default () => {};");

  const cache = cacheWithPaths([entry], {
    importFactory: async () => { throw new Error("jiti exploded"); },
  });

  const result = await cache.load(cwd, agentDir);

  assert.deepEqual(result.factories, []);
  assert.deepEqual(result.fallbackPaths, [entry]);
});

test("emits fallback path when importer returns undefined", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "no-default.ts");
  await writeFile(entry, "// no default export");

  const cache = cacheWithPaths([entry], {
    importFactory: async () => undefined,
  });

  const result = await cache.load(cwd, agentDir);

  assert.deepEqual(result.factories, []);
  assert.deepEqual(result.fallbackPaths, [entry]);
});

test("fallback decision is sticky until file mtime or size changes", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "flaky.ts");
  await writeFile(entry, "export default () => {};");

  let calls = 0;
  const factory = () => {};
  const cache = cacheWithPaths([entry], {
    importFactory: async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return factory;
    },
  });

  const first = await cache.load(cwd, agentDir);
  assert.deepEqual(first.fallbackPaths, [entry]);

  const second = await cache.load(cwd, agentDir);
  assert.equal(calls, 1, "importer should not be retried while sticky");
  assert.deepEqual(second.fallbackPaths, [entry]);
  assert.deepEqual(second.factories, []);

  await writeFile(entry, "export default () => { /* fixed */ };");
  await utimes(entry, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

  const third = await cache.load(cwd, agentDir);
  assert.equal(calls, 2);
  assert.deepEqual(third.fallbackPaths, []);
  assert.equal(third.factories.length, 1);
});

test("reimports factory when file mtime or size changes", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "alpha.ts");
  await writeFile(entry, "export default () => {};");

  const factories = [() => {}, () => {}];
  let calls = 0;
  const cache = cacheWithPaths([entry], {
    importFactory: async () => factories[calls++],
  });

  const first = await cache.load(cwd, agentDir);
  assert.equal(first.factories[0], factories[0]);

  // Change content (changes size) and mtime, then reload.
  await writeFile(entry, "export default () => { /* updated */ };");
  await utimes(entry, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

  const second = await cache.load(cwd, agentDir);
  assert.equal(calls, 2);
  assert.equal(second.factories[0], factories[1]);
});

test("reuses cached factories when file mtime and size are unchanged", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "alpha.ts");
  await writeFile(entry, "export default () => {};");

  let importCalls = 0;
  const factory = () => {};
  const cache = cacheWithPaths([entry], {
    importFactory: async () => { importCalls += 1; return factory; },
  });

  const first = await cache.load(cwd, agentDir);
  const second = await cache.load(cwd, agentDir);

  assert.equal(importCalls, 1);
  assert.equal(first.factories.length, 1);
  assert.equal(second.factories.length, 1);
  assert.equal(second.factories[0], factory);
});

test("deduplicates duplicate paths returned by discovery", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "dual.ts");
  await writeFile(entry, "export default () => {};");

  const imported: string[] = [];
  const cache = cacheWithPaths([entry, entry], {
    importFactory: async (path: string) => { imported.push(path); return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.deepEqual(imported, [entry]);
  assert.equal(result.factories.length, 1);
});

test("auto-discovers project extension paths before agentDir extension paths", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const globalEntry = join(agentDir, "extensions", "global.ts");
  const projectEntry = join(cwd, ".pi", "extensions", "project.ts");
  await writeFile(globalEntry, "export default () => {};");
  await writeFile(projectEntry, "export default () => {};");

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    importFactory: async (path: string) => {
      imported.push(path);
      return () => {};
    },
  });

  const result = await cache.load(cwd, agentDir);

  assert.equal(result.factories.length, 2);
  assert.deepEqual(result.fallbackPaths, []);
  assert.deepEqual(imported, [projectEntry, globalEntry]);
});
