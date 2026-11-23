import { parseArgs } from "node:util";
import { CliError, EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";
import { startPortForward } from "../lib/port-forward.mjs";
import { withSessionActivity } from "../lib/session-activity.mjs";
import { requireColabRuntime, resolveSession } from "../lib/session-store.mjs";

function parsePort(value, what, lowest = 1) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < lowest || port > 65535) {
    throw new CliError(`invalid ${what}: ${value}`);
  }
  return port;
}

// `orca-colab forward --port 8000`: http://127.0.0.1:8000 on this machine answers with what port 8000 on
// the runtime answers, until the command is interrupted.
export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    homeDir,
    signal,
    fetchImpl = fetch,
    execTty,
    withActivity = withSessionActivity,
    startForward = startPortForward,
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        session: { type: "string" },
        port: { type: "string" },
        listen: { type: "string" },
        timeout: { type: "string", default: "300" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;
  if (!opts.port) {
    throw new CliError("usage: orca-colab forward --port <remote port> [--session N] [--listen 127.0.0.1:<local port>] [--timeout seconds]");
  }
  const remotePort = parsePort(opts.port, "--port");
  let listenHost = "127.0.0.1";
  let listenPort = remotePort;
  if (opts.listen) {
    const at = opts.listen.lastIndexOf(":");
    listenHost = at > 0 ? opts.listen.slice(0, at).replace(/^\[|\]$/g, "") : listenHost;
    // Port 0 lets the system pick a free one; the chosen address is printed.
    listenPort = parsePort(at >= 0 ? opts.listen.slice(at + 1) : opts.listen, "--listen", 0);
  }
  const requestTimeoutSeconds = Number(opts.timeout);
  if (!Number.isFinite(requestTimeoutSeconds) || requestTimeoutSeconds <= 0) {
    throw new CliError(`invalid --timeout: ${opts.timeout}`);
  }

  const session = resolveSession({ sessionName: opts.session ?? null, homeDir });
  requireColabRuntime(session);

  // Started by the MCP server, the listener outlives the pipes it was given.
  for (const stream of [stdout, stderr]) {
    stream.on?.("error", () => {});
  }

  const serve = async () => {
    const forward = await startForward({
      sessionName: session.name,
      remotePort,
      listenHost,
      listenPort,
      requestTimeoutSeconds,
      homeDir,
      fetchImpl,
      ...(execTty ? { execTty } : {}),
      onLog: (line) => log(line, stderr),
    });
    const url = `http://${forward.listen}`;
    log(`Forwarding ${url} -> ${session.name} port ${remotePort}. Press Ctrl-C to stop.`, stderr);
    if (json) {
      writeJson(
        { ok: true, session: session.name, remotePort, listen: forward.listen, url, pid: process.pid },
        stdout,
      );
    }
    await new Promise((resolve) => {
      if (signal) {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", resolve, { once: true });
      } else {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      }
    });
    await forward.close();
    log("Forward stopped.", stderr);
    return EXIT_OK;
  };

  // The live pid keeps the idle watchdog from stopping a session that only serves requests.
  return withActivity ? withActivity(session.name, homeDir, serve) : serve();
}
