#!/usr/bin/env node
// Checks that HEAD is a well-formed release (see AGENTS.md § Git): package.json and orca-plugin.json
// carry the tag's version, every npx pin names one commit, and that commit's CLI files equal HEAD's.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPins, REPO_ROOT } from "./release-pin.mjs";

const CLI_PATHS = ["bin", "package.json"];

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

export function verifyRelease(tag) {
  const problems = [];
  const version = String(tag).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`tag ${tag} is not vX.Y.Z`);
  for (const file of ["package.json", "orca-plugin.json"]) {
    const v = JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")).version;
    if (v !== version) problems.push(`${file} has version ${v}, expected ${version}`);
  }
  const refs = [...new Set(readPins().map((p) => p.ref))];
  if (refs.length !== 1) {
    problems.push(`pins name ${refs.length} different refs: ${refs.join(", ")}`);
    return problems;
  }
  const [sha] = refs;
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    problems.push(`pin ${sha} is not a full commit SHA`);
    return problems;
  }
  try {
    git(["merge-base", "--is-ancestor", sha, "HEAD"]);
  } catch {
    problems.push(`pinned commit ${sha} is not an ancestor of HEAD`);
    return problems;
  }
  const drift = git(["diff", "--name-only", sha, "HEAD", "--", ...CLI_PATHS]);
  if (drift) problems.push(`CLI files differ between pinned ${sha.slice(0, 7)} and HEAD: ${drift.split("\n").join(", ")}`);
  const pinnedVersion = JSON.parse(git(["show", `${sha}:package.json`])).version;
  if (pinnedVersion !== version) problems.push(`pinned commit has version ${pinnedVersion}, expected ${version}`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag) {
    process.stderr.write("usage: node scripts/release-verify.mjs <vX.Y.Z>\n");
    process.exit(2);
  }
  const problems = verifyRelease(tag);
  for (const p of problems) process.stderr.write(`release-verify: ${p}\n`);
  if (problems.length === 0) process.stdout.write(`${tag} ok: pins ${readPins()[0].ref}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}
