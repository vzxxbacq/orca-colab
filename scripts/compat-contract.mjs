#!/usr/bin/env node
// Prints the public contract of an orca-colab checkout as JSON: everything AGENTS.md calls breaking when
// removed or changed (commands, flags, --json fields, exit codes, ~/.orca-colab formats, watch protocol,
// plugin settings, capabilities, engines.orca). CI runs it on the PR head and on its base and diffs them.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXED_ISO = "2026-01-01T00:00:00.000Z";
const SESSION_FIXTURE = {
  name: "orca-colab-fixture",
  account: "default",
  hostname: "orca-colab-fixture",
  transport: "colab-tty",
  gpu: { name: "Tesla T4", memoryTotalMiB: 15360, driverVersion: null },
  rateKey: "T4",
  cuPerHour: 1.96,
  createdAt: FIXED_ISO,
  lastActivityAt: FIXED_ISO,
  activePids: [],
  keep: false,
  state: "active",
  remoteRoot: "/content/orca/fixture",
  colabRuntime: { id: "r-fixture", endpoint: "r-fixture", baseUrl: "https://8080-fixture.colab.dev", token: "t", tokenExpiry: FIXED_ISO },
};
const TASK_FIXTURE = {
  id: "task-fixture-0001",
  name: "fixture",
  command: ["true"],
  sessionName: "orca-colab-fixture",
  account: "default",
  cwd: null,
  status: "succeeded",
  exitCode: 0,
  createdAt: FIXED_ISO,
  startedAt: FIXED_ISO,
  finishedAt: FIXED_ISO,
};
const LEDGER_FIXTURE = [
  { type: "session.start", at: FIXED_ISO, session: "orca-colab-fixture", account: "default", rateKey: "T4", cuPerHour: 1.96 },
  { type: "session.end", at: FIXED_ISO, session: "orca-colab-fixture", account: "default", cause: "user" },
  { type: "calibrate", at: FIXED_ISO, account: "default", balanceCu: 100, source: "manual" },
  { type: "budget.set", at: FIXED_ISO, account: "default", budgetCu: 50 },
];
// Offline commands whose --json output is part of the contract; the rest need a live runtime.
const JSON_PROBES = [
  ["--help"],
  ["doctor"],
  ["status"],
  ["ls"],
  ["credits"],
  ["ledger"],
  ["rates"],
  ["job", "ls"],
  ["auth", "status"],
  ["auth", "list"],
];

const sorted = (values) => [...new Set(values)].sort();

function load(root, rel) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

// Top-level keys of every `options: { … }` object literal handed to parseArgs in a command file.
export function extractParseArgsOptions(source) {
  const flags = {};
  let from = 0;
  for (;;) {
    const at = source.indexOf("options:", from);
    if (at === -1) break;
    const open = source.indexOf("{", at);
    if (open === -1 || source.slice(at + 8, open).trim() !== "") {
      from = at + 8;
      continue;
    }
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}" && --depth === 0) break;
    }
    const body = source.slice(open + 1, end);
    let d = 0;
    let segment = "";
    for (const ch of body) {
      if (ch === "{") d += 1;
      if (ch === "}") d -= 1;
      if (d === 0 && ch === ",") {
        const m = segment.match(/^\s*(?:"([\w-]+)"|([\w]+))\s*:\s*\{[^}]*type:\s*"(\w+)"/s);
        if (m) flags[m[1] || m[2]] = m[3];
        segment = "";
      } else {
        segment += ch;
      }
    }
    const m = segment.match(/^\s*(?:"([\w-]+)"|([\w]+))\s*:\s*\{[^}]*type:\s*"(\w+)"/s);
    if (m) flags[m[1] || m[2]] = m[3];
    from = end;
  }
  return flags;
}

// Key paths of a JSON value; array elements collapse into `[]` so list length never matters.
export function jsonKeyPaths(value, prefix = "") {
  if (Array.isArray(value)) {
    return sorted(value.flatMap((v) => jsonKeyPaths(v, `${prefix}[]`)));
  }
  if (value && typeof value === "object") {
    return sorted(
      Object.entries(value).flatMap(([k, v]) => {
        const p = prefix ? `${prefix}.${k}` : k;
        return [p, ...jsonKeyPaths(v, p)];
      }),
    );
  }
  return [];
}

function seedHome(homeDir) {
  const base = path.join(homeDir, ".orca-colab");
  mkdirSync(path.join(base, "sessions"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(base, "tasks"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(base, "sessions", `${SESSION_FIXTURE.name}.json`), JSON.stringify(SESSION_FIXTURE));
  writeFileSync(path.join(base, "tasks", `${TASK_FIXTURE.id}.json`), JSON.stringify(TASK_FIXTURE));
  writeFileSync(path.join(base, "tasks", `${TASK_FIXTURE.id}.log`), "fixture\n");
  writeFileSync(path.join(base, "ledger.jsonl"), `${LEDGER_FIXTURE.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

async function jsonOutputs(root) {
  const { main } = await load(root, "bin/orca-colab.mjs");
  const out = {};
  for (const args of JSON_PROBES) {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "orca-colab-contract-"));
    try {
      seedHome(homeDir);
      let text = "";
      const exitCode = await main([...args, "--json"], {
        stdout: { write: (c) => { text += c; } },
        stderr: { write() {} },
        env: { PATH: process.env.PATH ?? "", ORCA_COLAB_DISABLE_ORCA_CLI: "1" },
        cwd: homeDir,
        homeDir,
      });
      out[args.join(" ")] = { exitCode, keys: jsonKeyPaths(JSON.parse(text)) };
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }
  return out;
}

async function cliSurface(root) {
  const commandsDir = path.join(root, "bin", "commands");
  const flags = {};
  const subcommands = {};
  for (const file of readdirSync(commandsDir).filter((f) => f.endsWith(".mjs")).sort()) {
    const name = file.replace(/\.mjs$/, "");
    const source = readFileSync(path.join(commandsDir, file), "utf8");
    flags[name] = extractParseArgsOptions(source);
    const subs = [...source.matchAll(/\bsub(?:command)?\s*===\s*"([\w-]+)"/g)].map((m) => m[1]);
    if (subs.length > 0) subcommands[name] = sorted(subs);
  }
  const { main } = await load(root, "bin/orca-colab.mjs");
  let help = "";
  await main(["--help", "--json"], { stdout: { write: (c) => { help += c; } }, stderr: { write() {} } });
  const commands = sorted(JSON.parse(help).commands);
  const output = await load(root, "bin/lib/cli-output.mjs");
  const exitCodes = Object.fromEntries(
    Object.entries(output).filter(([k, v]) => k.startsWith("EXIT_") && typeof v === "number"),
  );
  return { commands, flags, subcommands, exitCodes };
}

async function fileFormats(root) {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "orca-colab-contract-"));
  try {
    const { normalizeSession } = await load(root, "bin/lib/session-store.mjs");
    const { normalizeConfig } = await load(root, "bin/lib/colab-home.mjs");
    const { normalizeTask } = await load(root, "bin/lib/task-store.mjs");
    const ledgerSource = readFileSync(path.join(root, "bin", "lib", "credit-ledger.mjs"), "utf8");
    return {
      session: jsonKeyPaths(normalizeSession(SESSION_FIXTURE)),
      config: jsonKeyPaths(normalizeConfig({ allowedGpus: ["T4"], maxConcurrentSessions: 1 })),
      task: jsonKeyPaths(normalizeTask(TASK_FIXTURE, homeDir)),
      ledgerEventTypes: sorted([...ledgerSource.matchAll(/type:\s*"([\w.]+)"/g)].map((m) => m[1])),
    };
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

async function watchProtocol(root) {
  const watchSource = readFileSync(path.join(root, "bin", "commands", "watch.mjs"), "utf8");
  const frames = await load(root, "bin/lib/bridge-frames.mjs");
  const { PANEL_ACTION_NAMES } = await load(root, "bin/lib/panel-actions.mjs");
  const verbs = watchSource.match(/CONTROL_SEGMENT_RE\s*=\s*\/\\b\(([^)]+)\)/);
  return {
    protocol: Number(watchSource.match(/WATCH_PROTOCOL\s*=\s*(\d+)/)?.[1] ?? NaN),
    framePrefix: frames.FRAME_PREFIX,
    frameKinds: sorted([...watchSource.matchAll(/emit\("(\w+)"/g)].map((m) => m[1])),
    controlVerbs: verbs ? sorted(verbs[1].split("|")) : [],
    panelActions: sorted(PANEL_ACTION_NAMES),
  };
}

function pluginManifest(root) {
  const m = JSON.parse(readFileSync(path.join(root, "orca-plugin.json"), "utf8"));
  const ids = (list) => sorted((list || []).map((x) => x.id));
  return {
    id: m.id,
    main: m.main ?? null,
    enginesOrca: m.engines?.orca ?? null,
    settings: Object.fromEntries((m.contributes?.settings || []).map((s) => [s.key, s.type])),
    commands: ids(m.contributes?.commands),
    panels: ids(m.contributes?.panels),
    statusBarItems: ids(m.contributes?.statusBarItems),
    capabilities: sorted((m.capabilities || []).map((c) => c.kind)),
  };
}

export async function buildContract(root, { allowMissing = false } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const contract = { version: pkg.version };
  const sections = {
    cli: () => cliSurface(root),
    jsonOutputs: () => jsonOutputs(root),
    files: () => fileFormats(root),
    watch: () => watchProtocol(root),
    plugin: () => pluginManifest(root),
  };
  for (const [name, build] of Object.entries(sections)) {
    try {
      contract[name] = await build();
    } catch (err) {
      // An older base may predate a section; a broken head must fail the build.
      if (!allowMissing) throw err;
      contract[name] = null;
    }
  }
  return contract;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
  const contract = await buildContract(root, { allowMissing: args.includes("--allow-missing") });
  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
}
