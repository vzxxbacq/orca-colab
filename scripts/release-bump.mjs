#!/usr/bin/env node
// Sets the release version in package.json and orca-plugin.json without reformatting either file.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./release-pin.mjs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  process.stderr.write("usage: node scripts/release-bump.mjs <X.Y.Z>\n");
  process.exit(2);
}
for (const file of ["package.json", "orca-plugin.json"]) {
  const full = path.join(REPO_ROOT, file);
  const text = readFileSync(full, "utf8");
  const next = text.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    process.stderr.write(`${file}: no version field to update\n`);
    process.exit(1);
  }
  writeFileSync(full, next);
}
process.stdout.write(`${version}\n`);
