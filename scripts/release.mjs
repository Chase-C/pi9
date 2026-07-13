#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RELEASE_BRANCH = "main";
const PACKAGES = {
  context: { workspace: "@pi9/context", dir: "packages/context", tagPrefix: "context-v" },
  subagent: { workspace: "@pi9/subagent", dir: "packages/subagent", tagPrefix: "subagent-v" },
  todo: { workspace: "@pi9/todo", dir: "packages/todo", tagPrefix: "todo-v" },
  whisper: { workspace: "@pi9/whisper", dir: "packages/whisper", tagPrefix: "whisper-v" },
};
const KEYWORDS = ["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"];

const args = process.argv.slice(2);
const packageKey = args[0];
const bump = args.slice(1).find(arg => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const skipChecks = args.includes("--skip-checks");
const target = PACKAGES[packageKey];

function abort(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function capture(command, commandArgs) {
  return execFileSync(command, commandArgs, { cwd: ROOT, encoding: "utf8" }).trim();
}

function succeeds(command, commandArgs) {
  try {
    execFileSync(command, commandArgs, { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function check(condition, message) {
  if (condition) return;
  if (dryRun) console.warn(`  ⚠ would abort: ${message}`);
  else abort(message);
}

function mutate(command, commandArgs) {
  if (dryRun) {
    console.log(`  [dry-run] ${command} ${commandArgs.join(" ")}`);
    return;
  }
  execFileSync(command, commandArgs, { cwd: ROOT, stdio: "inherit" });
}

function resolveNextVersion(currentVersion, requestedBump) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedBump)) return requestedBump;

  const dir = mkdtempSync(join(tmpdir(), "pi9-release-version-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "version-probe", version: currentVersion }));
    return execFileSync(
      "npm",
      ["version", requestedBump, "--no-git-tag-version", "--ignore-scripts", "--prefix", dir],
      { encoding: "utf8" },
    ).trim().replace(/^v/, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function prepareChangelog(content, version, date, newTag) {
  const heading = content.match(/^## \[Unreleased\](?: - .*?)?$/m);
  if (!heading || heading.index === undefined) abort("CHANGELOG.md must contain an [Unreleased] section.");
  if (new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](?: |$)`, "m").test(content)) {
    abort(`CHANGELOG.md already contains a ${version} release section.`);
  }

  const bodyStart = heading.index + heading[0].length;
  const nextHeading = content.slice(bodyStart).match(/^## \[/m);
  if (!nextHeading || nextHeading.index === undefined) abort("CHANGELOG.md needs a released section after [Unreleased].");
  const nextSectionStart = bodyStart + nextHeading.index;
  const notes = content.slice(bodyStart, nextSectionStart).trim();
  if (!notes) abort("CHANGELOG.md [Unreleased] has no entries to release.");

  const link = content.match(/^\[Unreleased\]:\s+(.+?\/compare\/)([^\s]+)\.\.\.HEAD$/m);
  if (!link) abort("CHANGELOG.md must contain an [Unreleased] comparison link ending in ...HEAD.");
  const [, comparePrefix, previousTag] = link;

  let updated = [
    content.slice(0, heading.index),
    "## [Unreleased]\n\n",
    `## [${version}] - ${date}\n\n`,
    notes,
    "\n\n",
    content.slice(nextSectionStart),
  ].join("");
  updated = updated.replace(
    /^\[Unreleased\]:.*$/m,
    `[Unreleased]: ${comparePrefix}${newTag}...HEAD\n[${version}]: ${comparePrefix}${previousTag}...${newTag}`,
  );
  return { updated, notes };
}

if (!target || !bump) {
  abort("Usage: node scripts/release.mjs <context|subagent|todo|whisper> <patch|minor|major|x.y.z> [--dry-run] [--skip-checks]");
}
const explicitVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bump);
if (!KEYWORDS.includes(bump) && !explicitVersion) abort(`Invalid version bump: ${bump}`);

const packagePath = join(ROOT, target.dir, "package.json");
const changelogPath = join(ROOT, target.dir, "CHANGELOG.md");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const nextVersion = resolveNextVersion(packageJson.version, bump);
const newTag = `${target.tagPrefix}${nextVersion}`;
const date = new Date().toISOString().slice(0, 10);
const changelog = prepareChangelog(readFileSync(changelogPath, "utf8"), nextVersion, date, newTag);

console.log(`\n→ Releasing ${target.workspace} (${packageJson.version} → ${nextVersion})${dryRun ? " [dry-run]" : ""}\n`);

check(succeeds("gh", ["--version"]), "GitHub CLI (gh) is not installed.");
check(succeeds("gh", ["auth", "status"]), "GitHub CLI is not authenticated.");
check(capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]) === RELEASE_BRANCH, `Releases must be cut from ${RELEASE_BRANCH}.`);
check(capture("git", ["status", "--porcelain"]) === "", "Working tree is not clean.");

if (succeeds("git", ["fetch", "origin", RELEASE_BRANCH])) {
  const [behind] = capture("git", ["rev-list", "--left-right", "--count", `origin/${RELEASE_BRANCH}...HEAD`]).split(/\s+/).map(Number);
  check(behind === 0, `Local ${RELEASE_BRANCH} is ${behind} commit(s) behind origin/${RELEASE_BRANCH}.`);
}

if (!skipChecks) {
  mutate("npm", ["run", "typecheck", "--workspace", target.workspace]);
  mutate("npm", ["test", "--workspace", target.workspace]);
} else {
  console.log("⚠ Skipping package checks.");
}

if (dryRun) {
  console.log(`  [dry-run] set ${target.dir}/package.json version to ${nextVersion}`);
  console.log(`  [dry-run] roll CHANGELOG.md [Unreleased] into ${nextVersion}`);
} else {
  packageJson.version = nextVersion;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(changelogPath, changelog.updated);
  mutate("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
}

mutate("git", ["add", `${target.dir}/package.json`, `${target.dir}/CHANGELOG.md`, "package-lock.json"]);
mutate("git", ["commit", "-m", `Release ${newTag}`]);
mutate("git", ["tag", "-a", newTag, "-m", `Release ${newTag}`]);
mutate("git", ["push", "origin", RELEASE_BRANCH]);
mutate("git", ["push", "origin", newTag]);

if (dryRun) {
  console.log(`  [dry-run] gh release create ${newTag}`);
} else {
  mutate("gh", ["release", "create", newTag, "--title", newTag, "--generate-notes", "--notes", changelog.notes]);
}

console.log(`\n✔ ${dryRun ? "Would create" : "Created"} ${newTag}.\n`);
