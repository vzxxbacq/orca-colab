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
import { OAUTH_REAUTH_REQUIRED, reauthErrorPayload } from "./lib/colab-oauth.mjs";
import { installNetworkProxy, parseProxySetting } from "./lib/network-proxy.mjs";

const COMMANDS = new Set([
  "doctor",
  "auth",
  "up",
  "status",
  "ls",
  "run",
  "job",
  "sync",
  "pull",
  "down",
  "credits",
  "ledger",
  "rates",
  "mcp",
  "forward",
]);

const HELP_TEXT = `Usage: orca-colab <command> [options]

Commands:
  doctor     Check local prerequisites (node, git, tar, Google sign-in, proxy); --network reaches every endpoint
  auth       Sign in with Google OAuth (Passkey supported)
  up         Start or connect to a Colab GPU runtime through the Colab API
  status     List sessions and check reachability (alias: ls)
  ls         Alias for status
  run        Execute a command on the active Colab session
  job        Submit, list, stream logs, and stop GPU compute tasks
  sync       Push workspace files to the Colab session
  pull       Fetch files from the Colab session to the local workspace
  down       Release the Colab runtime and clean up local session state
  credits    Show estimated compute-unit balance, burn rate and budget
  ledger     Show session and calibration history
  rates      View or update the GPU compute-unit rate table
  forward    Forward a local HTTP port to a port on the Colab session
  mcp        Serve every command as MCP tools on stdio (connector for Orca bots, Claude Code, Codex)

Global options:
  --json          Emit a single JSON object on stdout (logs go to stderr)
  --proxy <p>     Proxy for every request: auto (default: HTTPS_PROXY / ALL_PROXY / NO_PROXY, then the
                  macOS or Windows system proxy), off, or a URL (http://host:port, socks5://host:port).
                  Same as ORCA_COLAB_PROXY; overrides the panel's Network proxy setting.
  -h, --help Show this help message
`;

function splitGlobalFlags(argv) {
  const dashDash = argv.indexOf("--");
  const head = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const tail = dashDash === -1 ? [] : argv.slice(dashDash);
  let json = false;
  let proxy = null;
  const filteredHead = [];
  for (let i = 0; i < head.length; i += 1) {
    const arg = head[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--proxy") {
      proxy = head[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--proxy=")) {
      proxy = arg.slice("--proxy=".length);
    } else {
      filteredHead.push(arg);
    }
  }
  return { json, proxy, args: [...filteredHead, ...tail] };
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  let env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const homeDir = overrides.homeDir ?? os.homedir();
  const signal = overrides.signal;

  const { json, proxy, args } = splitGlobalFlags(argv);
  const [command, ...rest] = args;

  if (proxy !== null) {
    try {
      parseProxySetting(proxy);
    } catch (err) {
      logError(err.message, stderr);
      if (json) {
        writeJson({ ok: false, error: err.message }, stdout);
      }
      return EXIT_ERROR;
    }
    env = { ...env, ORCA_COLAB_PROXY: proxy || "auto" };
  }
  installNetworkProxy({ env, homeDir });

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
      cliMain: main,
      ...overrides.commandContext,
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
          : err?.code === OAUTH_REAUTH_REQUIRED
            ? reauthErrorPayload(err)
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
