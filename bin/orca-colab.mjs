#!/usr/bin/env node
import { realpathSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  logError,
  writeJson,
} from "./lib/cli-output.mjs";

const COMMANDS = new Set([
  "doctor",
  "setup",
  "auth",
  "up",
  "status",
  "ls",
  "run",
  "job",
  "sync",
  "pull",
  "forward",
  "down",
  "credits",
  "ledger",
  "rates",
]);

const HELP_TEXT = `Usage: orca-colab <command> [options]

Commands:
  doctor     Check local prerequisites (Tailscale, ssh, rsync, git, config)
  setup      Configure Tailscale auth key, SSH keypair and bootstrap notebook
  auth       Sign in with Google OAuth (Colab VS Code Direct API, Passkey supported)
  up         Start or connect to a Colab GPU session (browserless with OAuth, or notebook)
  status     List sessions and check reachability (alias: ls)
  ls         Alias for status
  run        Execute a command on the active Colab session over SSH
  job        Submit, list, stream logs, and stop GPU compute tasks
  sync       Push workspace files to the Colab session
  pull       Fetch files from the Colab session to the local workspace
  forward    Forward a local port to the Colab session
  down       Release the Colab runtime and clean up local session state
  credits    Show estimated compute-unit balance, burn rate and budget
  ledger     Show session and calibration history
  rates      View or update the GPU compute-unit rate table

Global options:
  --json     Emit a single JSON object on stdout (logs go to stderr)
  -h, --help Show this help message
`;

function splitJsonFlag(argv) {
  const dashDash = argv.indexOf("--");
  const head = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const tail = dashDash === -1 ? [] : argv.slice(dashDash);
  let json = false;
  const filteredHead = [];
  for (const arg of head) {
    if (arg === "--json") {
      json = true;
    } else {
      filteredHead.push(arg);
    }
  }
  return { json, args: [...filteredHead, ...tail] };
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const homeDir = overrides.homeDir ?? os.homedir();
  const signal = overrides.signal;

  const { json, args } = splitJsonFlag(argv);
  const [command, ...rest] = args;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    if (json) {
      writeJson({ commands: [...COMMANDS] }, stdout);
    } else {
      stdout.write(HELP_TEXT);
    }
    return EXIT_OK;
  }

  if (!COMMANDS.has(command)) {
    logError(`unknown command: ${command}`, stderr);
    if (json) {
      writeJson({ ok: false, error: `unknown command: ${command}` }, stdout);
    }
    return EXIT_ERROR;
  }

  try {
    const mod = await import(`./commands/${command}.mjs`);
    const code = await mod.run(rest, {
      json,
      stdout,
      stderr,
      env,
      cwd,
      homeDir,
      signal,
      commandName: command,
    });
    return typeof code === "number" ? code : EXIT_OK;
  } catch (err) {
    const exitCode = err instanceof CliError ? err.exitCode : EXIT_ERROR;
    const message = err instanceof Error ? err.message : String(err);
    logError(message, stderr);
    if (json) {
      const payload =
        err instanceof CliError && err.payload
          ? err.payload
          : { ok: false, error: message };
      writeJson(payload, stdout);
    }
    return exitCode;
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const code = await main();
  process.exit(code);
}
