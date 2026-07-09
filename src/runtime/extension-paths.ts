import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const ownExtensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

export async function discoverInheritedExtensionPaths(cwd: string, agentDir: string): Promise<string[]> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  await settingsManager.reload();

  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve();
  const ownCanonicalPath = await canonicalPath(ownExtensionPath);
  const seen = new Set<string>();
  const inherited: string[] = [];

  for (const entry of resolved.extensions) {
    if (!entry.enabled) continue;
    const canonical = await canonicalPath(entry.path);
    if (canonical === ownCanonicalPath || seen.has(canonical)) continue;
    seen.add(canonical);
    inherited.push(entry.path);
  }

  return inherited;
}

async function canonicalPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return path.resolve(file);
  }
}
