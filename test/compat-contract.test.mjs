import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildContract, extractParseArgsOptions, jsonKeyPaths } from "../scripts/compat-contract.mjs";
import { diffContracts } from "../scripts/compat-diff.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseArgs options and JSON key paths are extracted the way the contract records them", () => {
  const source = `parseArgs({ args, options: {
    session: { type: "string" },
    "high-ram": { type: "boolean", default: false },
    env: { type: "string", multiple: true },
  }, strict: true });`;
  assert.deepEqual(extractParseArgsOptions(source), { session: "string", "high-ram": "boolean", env: "string" });
  assert.deepEqual(jsonKeyPaths({ sessions: [{ name: "a", gpu: { name: "T4" } }, { keep: true }] }), [
    "sessions",
    "sessions[].gpu",
    "sessions[].gpu.name",
    "sessions[].keep",
    "sessions[].name",
  ]);
});

test("removals, changed exit codes, new capabilities and a raised engines.orca are breaking; additions are not", () => {
  const base = {
    version: "0.3.0",
    cli: { commands: ["pull", "up"], flags: { up: { gpu: "string", keep: "boolean" } }, exitCodes: { EXIT_ZOMBIE: 4 } },
    plugin: { enginesOrca: ">=1.4.248", capabilities: ["terminal:read"], settings: { cliCommand: "string" } },
  };
  const head = {
    version: "0.4.0",
    cli: { commands: ["pull", "up", "logs"], flags: { up: { gpu: "string", region: "string" } }, exitCodes: { EXIT_ZOMBIE: 5 } },
    plugin: { enginesOrca: ">=1.5.0", capabilities: ["terminal:read", "files:write"], settings: { cliCommand: "string" } },
  };
  const result = diffContracts(base, head);
  assert.deepEqual(result.breaking, [
    "cli.flags.up.keep: removed",
    "cli.exitCodes.EXIT_ZOMBIE: changed 4 → 5",
    "plugin.enginesOrca: raised >=1.4.248 → >=1.5.0",
    "plugin.capabilities: added `files:write` (users must re-approve)",
  ]);
  assert.deepEqual(result.added, ["cli.commands: added `logs`", "cli.flags.up.region: added"]);
  assert.equal(result.majorBump, false);
  assert.equal(diffContracts(base, { ...head, version: "1.0.0" }).majorBump, true);
});

test("the repository's own contract has no breaking change against itself", async () => {
  const contract = await buildContract(REPO_ROOT);
  assert.ok(contract.cli.commands.includes("pull"));
  assert.equal(contract.cli.flags.up.gpu, "string");
  assert.deepEqual(diffContracts(contract, contract).breaking, []);
});
