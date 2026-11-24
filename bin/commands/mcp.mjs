import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CliError, EXIT_OK, log } from "../lib/cli-output.mjs";
import { serveMcpOverStdio } from "../lib/mcp-stdio-server.mjs";
import { createColabMcpTools, MCP_INSTRUCTIONS } from "../lib/mcp-tools.mjs";

const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

// `orca-colab mcp`: every CLI command as an MCP tool on stdio, running the same command code against the
// same ~/.orca-colab, so the Orca panel shows what an agent does here exactly as it shows CLI runs.
export async function run(
  argv,
  { stdout, stderr, env, homeDir, cliMain, stdin = process.stdin, toolOptions = {} },
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

  const tools = createColabMcpTools({ runMain: cliMain, homeDir, env, ...toolOptions });
  log(`MCP server ready on stdio (orca-colab ${PACKAGE.version}, ${tools.tools.length} tools).`, stderr);
  const server = serveMcpOverStdio({
    input: stdin,
    write,
    serverInfo: { name: "orca-colab", title: "Colab GPU", version: PACKAGE.version },
    instructions: MCP_INSTRUCTIONS,
    tools: tools.tools,
    callTool: tools.call,
  });
  await server.closed;
  await tools.settle();
  return EXIT_OK;
}
