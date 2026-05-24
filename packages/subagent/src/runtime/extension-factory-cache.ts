import { stat } from "node:fs/promises";

import { DefaultPackageManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { timingStart } from "./timing.js";

export type ExtensionFactoryImport = (path: string) => Promise<ExtensionFactory | undefined>;
export type ExtensionPathDiscovery = (cwd: string, agentDir: string) => Promise<string[]>;

export interface ExtensionFactoryCacheOptions {
  importFactory?: ExtensionFactoryImport;
  discoverPaths?: ExtensionPathDiscovery;
  bypass?: boolean;
}

export interface ExtensionFactoryLoad {
  factories: ExtensionFactory[];
  fallbackPaths: string[];
}

interface CachedFactoryEntry {
  kind: "factory";
  mtimeMs: number;
  size: number;
  factory: ExtensionFactory;
}

interface CachedFallbackEntry {
  kind: "fallback";
  mtimeMs: number;
  size: number;
}

type CachedEntry = CachedFactoryEntry | CachedFallbackEntry;

export class ExtensionFactoryCache {
  private readonly importFactory: ExtensionFactoryImport;
  private readonly discoverPaths: ExtensionPathDiscovery;
  private readonly entries = new Map<string, CachedEntry>();
  private readonly bypass: boolean;

  constructor(options: ExtensionFactoryCacheOptions = {}) {
    this.importFactory = options.importFactory ?? defaultImportFactory;
    this.discoverPaths = options.discoverPaths ?? discoverExtensionPaths;
    this.bypass = options.bypass ?? false;
  }

  async load(cwd: string, agentDir: string): Promise<ExtensionFactoryLoad> {
    const seen = new Set<string>();
    const paths: string[] = [];
    const endDiscover = timingStart("extensionFactoryCache.discover", { cwd, agentDir });
    for (const entry of await this.discoverPaths(cwd, agentDir)) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      paths.push(entry);
    }
    endDiscover({ count: paths.length });

    const factories: ExtensionFactory[] = [];
    const fallbackPaths: string[] = [];
    if (this.bypass) {
      return { factories, fallbackPaths: paths };
    }
    for (const entry of paths) {
      const meta = await statMeta(entry);
      if (!meta) continue;
      const cached = this.entries.get(entry);
      if (cached && cached.mtimeMs === meta.mtimeMs && cached.size === meta.size) {
        if (cached.kind === "factory") factories.push(cached.factory);
        else fallbackPaths.push(entry);
        continue;
      }
      const endImport = timingStart("extensionFactoryCache.import", { path: entry });
      let factory: ExtensionFactory | undefined;
      try {
        factory = await this.importFactory(entry);
        endImport({ ok: true, hasFactory: factory !== undefined });
      } catch (error) {
        endImport({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      if (factory) {
        this.entries.set(entry, { kind: "factory", ...meta, factory });
        factories.push(factory);
      } else {
        this.entries.set(entry, { kind: "fallback", ...meta });
        fallbackPaths.push(entry);
      }
    }
    return { factories, fallbackPaths };
  }

  clear(): void {
    this.entries.clear();
  }
}

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  fsCache: false,
});

const defaultImportFactory: ExtensionFactoryImport = async (file: string) => {
  const mod = await jiti.import<unknown>(file, { default: true });
  if (typeof mod === "function") return mod as ExtensionFactory;
  return undefined;
};

async function statMeta(file: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const info = await stat(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return undefined;
  }
}

async function discoverExtensionPaths(cwd: string, agentDir: string): Promise<string[]> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  await settingsManager.reload();

  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve();

  return resolved.extensions
    .filter((entry) => entry.enabled)
    .map((entry) => entry.path);
}
