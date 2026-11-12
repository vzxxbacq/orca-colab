#!/usr/bin/env node
// Compares two contracts from compat-contract.mjs. Anything the base had that the head lost or changed
// is breaking; additions are listed only. Exits 1 on a breaking change unless the head bumps the major
// version or --allow-breaking is passed (the owner's go-ahead, e.g. a `breaking-change` PR label).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IGNORED = new Set(["version"]);

function minVersion(range) {
  const m = String(range ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

function compareTriples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function walk(base, head, at, out) {
  if (base === null || base === undefined) return;
  if (head === null || head === undefined) {
    out.breaking.push(`${at}: removed`);
    return;
  }
  if (Array.isArray(base)) {
    const headSet = new Set(Array.isArray(head) ? head : []);
    const baseSet = new Set(base);
    for (const v of base) if (!headSet.has(v)) out.breaking.push(`${at}: removed \`${v}\``);
    for (const v of headSet) {
      if (baseSet.has(v)) continue;
      // New capabilities change what users approved, so Orca asks them to approve the plugin again.
      if (at === "plugin.capabilities") out.breaking.push(`${at}: added \`${v}\` (users must re-approve)`);
      else out.added.push(`${at}: added \`${v}\``);
    }
    return;
  }
  if (typeof base === "object") {
    for (const key of Object.keys(base)) {
      walk(base[key], head?.[key], at ? `${at}.${key}` : key, out);
    }
    for (const key of Object.keys(head ?? {})) {
      if (!(key in base) && !IGNORED.has(key)) out.added.push(`${at ? `${at}.${key}` : key}: added`);
    }
    return;
  }
  if (at === "plugin.enginesOrca") {
    const b = minVersion(base);
    const h = minVersion(head);
    if (b && h && compareTriples(h, b) > 0) out.breaking.push(`${at}: raised ${base} → ${head}`);
    return;
  }
  if (base !== head) out.breaking.push(`${at}: changed ${JSON.stringify(base)} → ${JSON.stringify(head)}`);
}

export function diffContracts(base, head) {
  const out = { breaking: [], added: [] };
  for (const key of Object.keys(base)) {
    if (IGNORED.has(key)) continue;
    if (base[key] !== null && (head[key] === null || head[key] === undefined)) {
      throw new Error(`head contract has no '${key}' section`);
    }
    walk(base[key], head[key], key, out);
  }
  const major = (v) => Number(String(v ?? "0").split(".")[0]);
  out.majorBump = major(head.version) > major(base.version);
  return out;
}

export function formatReport(result, { baseVersion, headVersion, allowBreaking }) {
  const lines = [`### Backward compatibility: ${baseVersion} → ${headVersion}`, ""];
  if (result.breaking.length === 0) {
    lines.push("No breaking changes.");
  } else {
    const why = result.majorBump
      ? "allowed: major version bump"
      : allowBreaking
        ? "allowed: owner approved (`breaking-change`)"
        : "**blocked**: needs the owner's go-ahead (`breaking-change` label or a major version)";
    lines.push(`**${result.breaking.length} breaking change(s)**, ${why}:`, "");
    for (const b of result.breaking) lines.push(`- ${b}`);
  }
  if (result.added.length > 0) {
    lines.push("", `<details><summary>${result.added.length} addition(s)</summary>`, "");
    for (const a of result.added) lines.push(`- ${a}`);
    lines.push("", "</details>");
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [basePath, headPath] = args.filter((a) => !a.startsWith("--"));
  if (!basePath || !headPath) {
    process.stderr.write("usage: node scripts/compat-diff.mjs <base.json> <head.json> [--allow-breaking]\n");
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(basePath, "utf8"));
  const head = JSON.parse(readFileSync(headPath, "utf8"));
  const allowBreaking = args.includes("--allow-breaking");
  const result = diffContracts(base, head);
  process.stdout.write(formatReport(result, { baseVersion: base.version, headVersion: head.version, allowBreaking }));
  process.exit(result.breaking.length > 0 && !result.majorBump && !allowBreaking ? 1 : 0);
}
