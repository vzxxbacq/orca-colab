#!/usr/bin/env node
// Points every `npx` pin at one release commit. Tags can move after review; a commit SHA cannot, so the
// plugin, the skill and the docs pin the full SHA. npm 10 fails on `github:owner/repo#<40-hex sha>`
// ("GitFetcher requires an Arborist constructor"), so the pin is GitHub's tarball URL for that commit.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PIN_FILES = [
  "orca-plugin.json",
  "worker/main.mjs",
  "skills/colab-gpu/SKILL.md",
  "skills/colab-gpu/references/cli.md",
  "README.md",
  "README.zh-CN.md",
  "docs/DESIGN.md",
];
export const PIN_PREFIX = "https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/";
export const PIN_RE = /(?:github:vzxxbacq\/orca-colab#|https:\/\/codeload\.github\.com\/vzxxbacq\/orca-colab\/tar\.gz\/)([^\s"`'<>)]+)/g;
// What `npx` actually runs; the pin commit may differ from the release commit only outside these paths.
const CLI_PATHS = ["bin", "package.json"];

export function readPins(root = REPO_ROOT) {
  return PIN_FILES.flatMap((file) =>
    [...readFileSync(path.join(root, file), "utf8").matchAll(PIN_RE)].map((m) => ({ file, ref: m[1] })),
  );
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function main([ref]) {
  if (!ref) {
    process.stderr.write("usage: node scripts/release-pin.mjs <release-commit>\n");
    process.exit(2);
  }
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  try {
    git(["merge-base", "--is-ancestor", sha, "HEAD"]);
  } catch {
    process.stderr.write(`${sha} is not an ancestor of HEAD; pin a commit that is on this branch.\n`);
    process.exit(1);
  }
  const drift = git(["diff", "--name-only", sha, "HEAD", "--", ...CLI_PATHS]);
  if (drift) {
    process.stderr.write(`CLI files changed since ${sha}; release that commit first:\n${drift}\n`);
    process.exit(1);
  }
  for (const file of PIN_FILES) {
    const full = path.join(REPO_ROOT, file);
    writeFileSync(full, readFileSync(full, "utf8").replace(PIN_RE, `${PIN_PREFIX}${sha}`));
  }
  process.stdout.write(`${sha}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
