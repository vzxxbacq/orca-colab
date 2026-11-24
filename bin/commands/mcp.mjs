import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CliError, EXIT_OK, log } from "../lib/cli-output.mjs";
import { serveMcpOverStdio } from "../lib/mcp-stdio-server.mjs";
import { createColabMcpTools, MCP_INSTRUCTIONS } from "../lib/mcp-tools.mjs";
import { RuntimePresenceKeeper, sessionNeedsPresence } from "../lib/runtime-presence.mjs";
import { listTasks } from "../lib/task-store.mjs";

const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

// `orca-colab mcp`: every CLI command as an MCP tool on stdio, running the same command code against the
// same ~/.orca-colab, so the Orca panel shows what an agent does here exactly as it shows CLI runs.
export async function run(
  argv,
  {
    stdout,
    stderr,
    env,
    homeDir,
    cliMain,
    stdin = process.stdin,
    toolOptions = {},
    presenceKeeper = new RuntimePresenceKeeper({ homeDir }),
    presenceEveryMs = 30_000,
  },
) {
  try {
    parseArgs({ args: argv, options: {}, strict: true, allowPositionals: false });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  // stdout carries the protocol and nothing else; a stray write from any module goes to stderr instead.
  const write = stdout.write.bind(stdout);
  if (stdout === process.stdout) {
    process.stdout.write = (...args) => process.stderr.write(...args);
    process.stdout.on("error", () => {});
  }

  // Runtimes and jobs started through this server are attributed to the MCP client that asked.
  const toolEnv = { ...env };
  const tools = createColabMcpTools({ runMain: cliMain, homeDir, env: toolEnv, ...toolOptions });
  log(`MCP server ready on stdio (orca-colab ${PACKAGE.version}, ${tools.tools.length} tools).`, stderr);
  const server = serveMcpOverStdio({
    input: stdin,
    write,
    serverInfo: { name: "orca-colab", title: "Colab GPU", version: PACKAGE.version },
    instructions: MCP_INSTRUCTIONS,
    tools: tools.tools,
    callTool: tools.call,
    onClientInfo: (info) => {
      if (!toolEnv.ORCA_COLAB_AGENT && typeof info?.name === "string" && info.name) {
        toolEnv.ORCA_COLAB_AGENT = info.name;
      }
    },
  });
  // Between an agent's tool calls this server is the client Colab sees on the runtime
  // (bin/lib/runtime-presence.mjs).
  const keepPresence = () => {
    try {
      const tasks = listTasks(homeDir);
      presenceKeeper.reconcile((session) =>
        sessionNeedsPresence({
          session,
          runningTasksCount: tasks.filter((t) => t.sessionName === session.name && t.status === "running").length,
        }),
      );
    } catch {
      // Transient read error; the next round retries.
    }
  };
  const presenceTimer = presenceKeeper ? setInterval(keepPresence, presenceEveryMs) : null;
  presenceTimer?.unref?.();
  await server.closed;
  clearInterval(presenceTimer);
  await presenceKeeper?.stop();
  await tools.settle();
  return EXIT_OK;
}
