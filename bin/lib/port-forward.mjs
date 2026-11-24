import { randomBytes } from "node:crypto";
import http from "node:http";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execCommandOverTty } from "./colab-api-client.mjs";
import { jupyterFilesUrl, uploadJupyterFile } from "./jupyter-files.mjs";
import { SessionGoneError, createRuntimeChannel } from "./runtime-channel.mjs";
import { readSession, writeSession } from "./session-store.mjs";

export { SessionGoneError, createRuntimeChannel };
import { isProcessAlive } from "./task-store.mjs";

// Colab's proxy reaches only Jupyter on 8080 (other ports, the per-port hosts and /proxy/<port> answer
// 404), and Jupyter there has no proxy extension. So a request travels as a file: the local listener
// writes it through the contents API, this helper on the runtime replays it against 127.0.0.1:<port> and
// writes the response next to it, and the listener reads that back from /files.
const HELPER_SOURCE = String.raw`
import base64, fcntl, http.client, json, os, shutil, sys, threading, time

root, port, timeout = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
INLINE_LIMIT = 256 * 1024
IDLE_LIMIT = 900
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"}

# One helper per directory: a second one would replay every request and remove the files the first one
# is still writing. A helper that was just ended may take a while to go when it waits for the disk.
lock = open(os.path.join(root, "lock"), "w")
for attempt in range(100):
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except OSError:
        time.sleep(0.2)
else:
    sys.exit(0)

active = set()
done = set()

def publish(rid, meta):
    tmp = os.path.join(root, "tmp-" + rid)
    with open(tmp, "w") as f:
        json.dump(meta, f)
    os.replace(tmp, os.path.join(root, "res-" + rid + ".json"))
    done.add(rid)

def replay(rid, path):
    try:
        with open(path, "rb") as f:
            meta = json.loads(f.readline())
            body = f.read()
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        try:
            conn.putrequest(meta["method"], meta["target"], skip_host=True, skip_accept_encoding=True)
            for key, value in meta["headers"]:
                if key.lower() not in HOP:
                    conn.putheader(key, value)
            if body or meta["method"] in ("POST", "PUT", "PATCH"):
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders(body or None)
            resp = conn.getresponse()
            body_path = os.path.join(root, "res-" + rid + ".body")
            size = 0
            with open(body_path, "wb") as out:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    size += len(chunk)
            headers = [[k, v] for k, v in resp.getheaders() if k.lower() not in HOP or (k.lower() == "content-length" and meta["method"] == "HEAD")]
            result = {"status": resp.status, "reason": resp.reason, "headers": headers, "bodyBytes": size}
            if size <= INLINE_LIMIT:
                with open(body_path, "rb") as f:
                    result["bodyBase64"] = base64.b64encode(f.read()).decode("ascii")
                os.remove(body_path)
            publish(rid, result)
        finally:
            conn.close()
    except (ConnectionRefusedError, ConnectionResetError, http.client.RemoteDisconnected) as err:
        publish(rid, {"error": "unreachable", "message": "nothing answered on 127.0.0.1:%d on the runtime (%s)" % (port, err)})
    except (TimeoutError, OSError) as err:
        timed_out = isinstance(err, TimeoutError) or "timed out" in str(err)
        publish(rid, {"error": "timeout" if timed_out else "failed", "message": "127.0.0.1:%d on the runtime: %s" % (port, err)})
    except Exception as err:
        publish(rid, {"error": "failed", "message": "%s: %s" % (type(err).__name__, err)})

def serve(rid, path):
    try:
        replay(rid, path)
    finally:
        active.discard(rid)

def complete(path):
    try:
        with open(path, "rb") as f:
            head = f.readline()
        if not head.endswith(b"\n"):
            return False
        return os.path.getsize(path) >= len(head) + json.loads(head)["bodyBytes"]
    except (OSError, ValueError, KeyError):
        return False

def mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0

def sweep(now):
    for entry in os.scandir(root):
        # Jupyter and the request threads create and rename files here all the time: one that is gone
        # by now needs no cleaning.
        try:
            age = now - entry.stat().st_mtime
            name = entry.name
            if name.startswith(("res-", "tmp-")):
                old = age > 180
            elif name.startswith("req-"):
                # A request stays until it is answered, so that a helper started after this one died
                # runs it again.
                old = age > 30 and name[4:] in done or age > timeout + 30
            else:
                old = False
            if old:
                os.remove(entry.path)
        except OSError:
            pass

# Jupyter stats a file again right after saving it, so a request file stays in place for a while; this set
# is what keeps it from running twice.
seen = {entry.name[4:-5] for entry in os.scandir(root) if entry.name.startswith("res-") and entry.name.endswith(".json")}
done.update(seen)
with open(os.path.join(root, "pid"), "w") as f:
    f.write(str(os.getpid()))
open(os.path.join(root, "alive"), "w").close()
last_beat = 0
last_request = time.time()
last_complaint = 0
while True:
    now = time.time()
    try:
        if now - last_beat > 5:
            os.makedirs(root, exist_ok=True)
            with open(os.path.join(root, "beat"), "w") as f:
                f.write(str(now))
            last_beat = now
            # A runtime busy with its disk lets keep-alives through late or not at all, so the listener
            # counts as gone only after a long silence, and never while one of its requests runs.
            idle = now - max(mtime(os.path.join(root, "alive")), last_request)
            if os.path.exists(os.path.join(root, "stop")) or (idle > IDLE_LIMIT and not active):
                shutil.rmtree(root, ignore_errors=True)
                sys.exit(0)
            sweep(now)
        for entry in os.scandir(root):
            rid = entry.name[4:]
            if entry.name.startswith("req-") and rid not in seen and complete(entry.path):
                seen.add(rid)
                active.add(rid)
                last_request = now
                threading.Thread(target=serve, args=(rid, entry.path), daemon=True).start()
    except Exception as err:
        if now - last_complaint > 60:
            last_complaint = now
            print("%s %s: %s" % (time.strftime("%H:%M:%S"), type(err).__name__, err), file=sys.stderr, flush=True)
    time.sleep(0.02)
`;

const MAX_BODY_BYTES = 256 * 1024 * 1024;
// A helper whose process exists but whose heartbeat is this old has stopped working.
const STUCK_AFTER_MS = 300_000;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Forwards of a session whose process still runs; what `status` and the panel show.
export function liveForwards(session, checkPid = isProcessAlive) {
  return (session?.forwards ?? []).filter((forward) => checkPid(forward.pid));
}

function recordForward(sessionName, homeDir, entry, { remove = false } = {}) {
  const session = readSession(sessionName, homeDir);
  if (!session) return;
  const others = liveForwards(session).filter((forward) => forward.pid !== entry.pid || forward.listen !== entry.listen);
  writeSession({ ...session, forwards: remove ? others : [...others, entry] }, homeDir);
}

function jsonReply(res, status, payload) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body over 256 MB"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startPortForward({
  sessionName,
  remotePort,
  listenHost = "127.0.0.1",
  listenPort = remotePort,
  requestTimeoutSeconds = 300,
  homeDir = os.homedir(),
  fetchImpl = fetch,
  execTty = execCommandOverTty,
  onLog = () => {},
  pollMs = 250,
  keepAliveMs = 30_000,
} = {}) {
  const channel = createRuntimeChannel({ sessionName, homeDir, fetchImpl });
  const root = `/tmp/orca-colab-forward-${remotePort}-${randomBytes(4).toString("hex")}`;
  let closed = false;

  // Counts helper starts: a request that sees it change knows its helper was replaced under it.
  let helperStarts = 0;

  async function startHelper() {
    const session = channel.session();
    const res = await execTty({
      baseUrl: session.colabRuntime.baseUrl,
      proxyToken: session.colabRuntime.token,
      fetchImpl,
      // Two helpers on one directory would replay every request twice, so one that is still there
      // (stuck, or only out of sight for a moment) is ended, and seen to be gone, before the new one
      // starts. Python takes many seconds to start on a runtime busy with its disk.
      command: `mkdir -p ${root} && cat > ${root}/helper.py && { p=$(cat ${root}/pid 2>/dev/null); if [ -n "$p" ] && grep -qa ${root}/helper.py /proc/$p/cmdline 2>/dev/null; then kill $p 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 $p 2>/dev/null || break; sleep 0.2; done; kill -9 $p 2>/dev/null; fi; rm -f ${root}/beat ${root}/stop; (setsid nohup python3 ${root}/helper.py ${root} ${remotePort} ${requestTimeoutSeconds} >> ${root}/helper.log 2>&1 < /dev/null &) ; } && i=0; while [ $i -lt 150 ] && ! test -e ${root}/beat; do sleep 0.2; i=$((i+1)); done; test -e ${root}/beat`,
      stdinBase64: Buffer.from(HELPER_SOURCE, "utf8").toString("base64"),
      timeoutMs: 90_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(`could not start the forwarding helper on the runtime: ${String(res.stdout).trim().slice(-300)}`);
    }
    helperStarts += 1;
  }

  // Asks the runtime itself whether the helper's process exists. A heartbeat file that cannot be read
  // says little: under heavy disk or network load Jupyter answers late, not at all, or with an error.
  async function probeHelper() {
    try {
      const session = channel.session();
      const res = await execTty({
        baseUrl: session.colabRuntime.baseUrl,
        proxyToken: session.colabRuntime.token,
        fetchImpl,
        command: `mkdir -p ${root}; s=dead; p=$(cat ${root}/pid 2>/dev/null); if [ -n "$p" ] && grep -qa ${root}/helper.py /proc/$p/cmdline 2>/dev/null; then s=alive; fi; echo "orca-helper:$s"`,
        timeoutMs: 45_000,
      });
      return /orca-helper:(alive|dead)/.exec(String(res.stdout))?.[1] ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  // The only way to a new helper, one caller at a time: it is started when the runtime says the old
  // one's process is gone, or (`evenIfAlive`) when that process has stopped working.
  let recovering = null;
  function recoverHelper(why, { evenIfAlive = false } = {}) {
    recovering ??= (async () => {
      const state = await probeHelper();
      if (closed || state === "unknown" || (state === "alive" && !evenIfAlive)) return state;
      onLog(`forwarding helper on the runtime ${state === "alive" ? "is stuck" : "is not running"} (${why}); starting it again`);
      await startHelper();
      return "restarted";
    })().finally(() => {
      recovering = null;
    });
    return recovering;
  }

  const remoteFile = (name) => `${channel.baseUrl()}/api/contents${root}/${name}`;

  // Keeps the helper alive, and starts a new one when the old one died with its runtime's processes.
  // A heartbeat that is unanswered, refused or old proves nothing (the proxy holds or refuses a request
  // now and then, answers 404 to an expired token, and a runtime busy with its disk answers late), so
  // after two bad checks in a row, the second one with a fresh token, the runtime is asked for the
  // helper's process; the heartbeat's age is measured on the runtime side's clock.
  let badBeats = 0;
  let keepingAlive = false;
  let slowNoted = false;
  async function keepAlive() {
    if (closed || keepingAlive) return;
    keepingAlive = true;
    try {
      const gone = (err) => {
        if (err instanceof SessionGoneError) throw err;
      };
      await channel
        .fetch(remoteFile("alive"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "file", format: "text", content: "" }),
          timeoutMs: 20_000,
        })
        .then((res) => res.arrayBuffer())
        .catch(gone);
      let ageMs = null;
      let why = "no answer for its heartbeat file";
      try {
        const beat = await channel.fetch(`${remoteFile("beat")}?content=0`, { timeoutMs: 20_000 });
        const info = beat.ok ? await beat.json() : null;
        await beat.arrayBuffer().catch(() => {});
        if (info) {
          ageMs = (Date.parse(beat.headers?.get?.("date") || "") || Date.now()) - Date.parse(info.last_modified);
          why = `its last sign of life is ${Math.round(ageMs / 1000)}s old`;
        } else {
          why = `HTTP ${beat.status} for its heartbeat file`;
        }
      } catch (err) {
        gone(err);
      }
      if (ageMs !== null && ageMs <= 30_000) {
        badBeats = 0;
        slowNoted = false;
        return;
      }
      badBeats += 1;
      if (badBeats === 1) {
        await channel.refreshToken();
        return;
      }
      const state = await recoverHelper(why, { evenIfAlive: ageMs !== null && ageMs > STUCK_AFTER_MS });
      if (state === "restarted") {
        badBeats = 0;
      } else if (!slowNoted) {
        slowNoted = true;
        onLog(
          state === "alive"
            ? `the runtime answers slowly (${why}); the forwarding helper is still running there and is left alone`
            : `the runtime does not answer (${why}); the forwarding helper is left alone until the runtime says it is gone`,
        );
      }
    } catch (err) {
      if (err instanceof SessionGoneError) {
        if (!goneLogged) onLog(`keep-alive stopped: ${err.message}`);
        goneLogged = true;
        return;
      }
      onLog(`keep-alive failed: ${err.message}`);
    } finally {
      keepingAlive = false;
    }
  }
  let goneLogged = false;

  async function forward(req, res) {
    const id = randomBytes(8).toString("hex");
    const body = await readBody(req);
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!HOP_BY_HOP.has(req.rawHeaders[i].toLowerCase())) {
        headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      }
    }
    const head = Buffer.from(
      `${JSON.stringify({ id, method: req.method, target: req.url, headers, bodyBytes: body.length })}\n`,
      "utf8",
    );
    const upload = () =>
      uploadJupyterFile({
        baseUrl: channel.baseUrl(),
        proxyToken: "",
        remotePath: `${root}/req-${id}`,
        contentBase64: Buffer.concat([head, body]).toString("base64"),
        fetchImpl: channel.fetch,
      });
    // The proxy answers 404, not 401, to a token that has expired, so a refused upload is tried once more
    // with a fresh token; a runtime that is gone fails the refresh with SessionGoneError. One refused
    // again may have lost its directory with a helper that stopped: the runtime is asked, then a last try.
    await upload()
      .catch(async () => {
        await channel.refreshToken();
        await upload();
      })
      .catch(async (err) => {
        if (err instanceof SessionGoneError) throw err;
        await recoverHelper("it does not take requests");
        await upload();
      });

    const deadline = Date.now() + (requestTimeoutSeconds + 20) * 1000;
    const startedMs = Date.now();
    let checkedMs = startedMs;
    let answeredMs = startedMs;
    let helperMissing = false;
    let helper = helperStarts;
    let replaced = false;
    let meta = null;
    let aborted = false;
    res.on("close", () => {
      aborted = !res.writableEnded;
    });
    // A read the runtime did not answer in time is a miss like any other while it is busy; a minute of
    // reads that never reached it is a runtime that cannot be reached.
    let unanswered = null;
    const read = (url) =>
      channel.fetch(url, { timeoutMs: 30_000 }).then(
        (answer) => {
          answeredMs = Date.now();
          unanswered = null;
          return answer;
        },
        (err) => {
          if (err instanceof SessionGoneError || (!err.timedOut && Date.now() - answeredMs > 60_000)) throw err;
          unanswered = err;
          return null;
        },
      );
    while (!meta) {
      if (aborted) return;
      if (Date.now() > deadline) {
        if (unanswered) throw unanswered;
        jsonReply(res, 504, {
          error: "forward_timeout",
          message: `No response from port ${remotePort} on the runtime within ${requestTimeoutSeconds}s.`,
        });
        return;
      }
      if (helper !== helperStarts) {
        // The new helper runs a request it finds unanswered again; one whose file went with the old
        // helper's directory is written again here. Once per request, not forever.
        if (replaced) {
          throw new Error("the forwarding helper on the runtime stopped twice while this request ran");
        }
        replaced = true;
        helper = helperStarts;
        const kept = await read(`${remoteFile(`req-${id}`)}?content=0`);
        await kept?.arrayBuffer().catch(() => {});
        if (kept?.status === 404) await upload();
      }
      const poll = await read(jupyterFilesUrl(channel.baseUrl(), `${root}/res-${id}.json`));
      if (poll?.ok) {
        meta = await poll.json();
        break;
      }
      await poll?.arrayBuffer().catch(() => {});
      if (Date.now() - checkedMs > 10_000) {
        // A missing response is normal while the service works; a missing helper is not.
        checkedMs = Date.now();
        const beat = await read(jupyterFilesUrl(channel.baseUrl(), `${root}/beat`));
        await beat?.arrayBuffer().catch(() => {});
        if (beat && !beat.ok) {
          if (helperMissing) {
            helperMissing = false;
            await recoverHelper(`HTTP ${beat.status} for its heartbeat file`);
          } else {
            helperMissing = true;
            await channel.refreshToken();
          }
        } else if (beat) {
          helperMissing = false;
        }
      }
      // The first seconds poll back to back: one round trip is already about a quarter of a second.
      if (Date.now() - startedMs > 3000) {
        await new Promise((resolve) => setTimeout(resolve, Date.now() - startedMs > 30_000 ? pollMs * 4 : pollMs));
      }
    }

    if (meta.error) {
      jsonReply(res, meta.error === "timeout" ? 504 : 502, {
        error: meta.error === "unreachable" ? "port_unreachable" : `forward_${meta.error}`,
        message: meta.message,
      });
      return;
    }

    const rawHeaders = meta.headers.flat();
    if (req.method !== "HEAD") {
      rawHeaders.push("Content-Length", String(meta.bodyBytes));
    }
    res.writeHead(meta.status, meta.reason, rawHeaders);
    if (req.method === "HEAD" || meta.bodyBytes === 0) {
      res.end();
    } else if (typeof meta.bodyBase64 === "string") {
      res.end(Buffer.from(meta.bodyBase64, "base64"));
    } else {
      const download = await channel.fetch(jupyterFilesUrl(channel.baseUrl(), `${root}/res-${id}.body`));
      if (!download.ok || !download.body) {
        res.destroy();
        return;
      }
      await pipeline(Readable.fromWeb(download.body), res);
    }
  }

  const server = http.createServer((req, res) => {
    forward(req, res).catch(async (failure) => {
      // Asking Colab tells a released runtime from a network hiccup.
      const err =
        failure instanceof SessionGoneError || failure?.code === "TOO_LARGE"
          ? failure
          : await channel.refreshToken().then(() => failure, (gone) => (gone instanceof SessionGoneError ? gone : failure));
      if (err instanceof SessionGoneError) {
        jsonReply(res, 502, { error: "session_gone", message: err.message });
      } else if (err?.code === "TOO_LARGE") {
        jsonReply(res, 413, { error: "body_too_large", message: err.message });
      } else {
        jsonReply(res, 502, {
          error: "forward_failed",
          message: `Could not reach the Colab runtime of session '${sessionName}': ${typeof err?.cause?.code === "string" ? err.cause.code : err.message}. If the runtime was released, start it again and restart 'orca-colab forward'.`,
        });
      }
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  await startHelper();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, resolve);
  });
  const timer = setInterval(() => void keepAlive(), keepAliveMs);
  timer.unref?.();
  const address = server.address();
  const record = {
    pid: process.pid,
    remotePort,
    listen: `${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    startedAt: new Date().toISOString(),
  };
  recordForward(sessionName, homeDir, record);

  return {
    root,
    address,
    listen: record.listen,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      recordForward(sessionName, homeDir, record, { remove: true });
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      try {
        const res = await channel.fetch(remoteFile("stop"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "file", format: "text", content: "" }),
        });
        await res.arrayBuffer();
      } catch {
        // The runtime is gone or unreachable; the helper stops by itself without keep-alives.
      }
    },
  };
}
