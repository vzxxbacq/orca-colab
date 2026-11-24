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
import base64, http.client, json, os, shutil, sys, threading, time

root, port, timeout = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
INLINE_LIMIT = 256 * 1024
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"}

def publish(rid, meta):
    tmp = os.path.join(root, "tmp-" + rid)
    with open(tmp, "w") as f:
        json.dump(meta, f)
    os.replace(tmp, os.path.join(root, "res-" + rid + ".json"))

def serve(rid, path):
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

def complete(path):
    try:
        with open(path, "rb") as f:
            head = f.readline()
        if not head.endswith(b"\n"):
            return False
        return os.path.getsize(path) >= len(head) + json.loads(head)["bodyBytes"]
    except (OSError, ValueError, KeyError):
        return False

# Jupyter stats a file again right after saving it, so a request file stays in place for a while; this set
# is what keeps it from running twice.
seen = {entry.name[4:-5] for entry in os.scandir(root) if entry.name.startswith("res-") and entry.name.endswith(".json")}
with open(os.path.join(root, "pid"), "w") as f:
    f.write(str(os.getpid()))
open(os.path.join(root, "alive"), "w").close()
last_beat = 0
while True:
    now = time.time()
    if now - last_beat > 5:
        last_beat = now
        with open(os.path.join(root, "beat"), "w") as f:
            f.write(str(now))
        try:
            idle = now - os.path.getmtime(os.path.join(root, "alive"))
        except OSError:
            idle = 1e9
        if idle > 180 or os.path.exists(os.path.join(root, "stop")):
            shutil.rmtree(root, ignore_errors=True)
            sys.exit(0)
        for entry in os.scandir(root):
            age = now - entry.stat().st_mtime
            if (entry.name.startswith(("res-", "tmp-")) and age > 180) or (entry.name.startswith("req-") and age > 30 and entry.name[4:] in seen):
                os.remove(entry.path)
    for entry in os.scandir(root):
        if entry.name.startswith("req-") and entry.name[4:] not in seen and complete(entry.path):
            seen.add(entry.name[4:])
            threading.Thread(target=serve, args=(entry.name[4:], entry.path), daemon=True).start()
    time.sleep(0.02)
`;

const MAX_BODY_BYTES = 256 * 1024 * 1024;
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

  async function startHelper() {
    const session = channel.session();
    const res = await execTty({
      baseUrl: session.colabRuntime.baseUrl,
      proxyToken: session.colabRuntime.token,
      fetchImpl,
      // Two helpers on one directory would replay every request twice, so one that is still there
      // (stuck, or only out of sight for a moment) is ended before the new one starts.
      command: `mkdir -p ${root} && cat > ${root}/helper.py && { test -e ${root}/pid && kill "$(cat ${root}/pid)" 2>/dev/null && sleep 0.3; rm -f ${root}/beat ${root}/stop; (setsid nohup python3 ${root}/helper.py ${root} ${remotePort} ${requestTimeoutSeconds} >> ${root}/helper.log 2>&1 < /dev/null &) ; } && for i in 1 2 3 4 5 6 7 8 9 10; do test -e ${root}/beat && break; sleep 0.2; done; test -e ${root}/beat`,
      stdinBase64: Buffer.from(HELPER_SOURCE, "utf8").toString("base64"),
      timeoutMs: 60_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(`could not start the forwarding helper on the runtime: ${String(res.stdout).trim().slice(-300)}`);
    }
  }

  const remoteFile = (name) => `${channel.baseUrl()}/api/contents${root}/${name}`;

  // Keeps the helper alive, and starts a new one when the old one died with its runtime's processes.
  // One unanswered or refused read proves nothing (the proxy holds or refuses a request now and then,
  // and answers 404 to an expired token), so the helper is restarted only after two bad checks in a
  // row, the second one with a fresh token; its age is measured on the runtime side's clock.
  let badBeats = 0;
  async function keepAlive() {
    if (closed) return;
    try {
      await channel.fetch(remoteFile("alive"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "file", format: "text", content: "" }),
      }).then((res) => res.arrayBuffer());
      const beat = await channel.fetch(`${remoteFile("beat")}?content=0`);
      const info = beat.ok ? await beat.json() : null;
      await beat.arrayBuffer().catch(() => {});
      const serverNowMs = Date.parse(beat.headers?.get?.("date") || "") || Date.now();
      if (info && serverNowMs - Date.parse(info.last_modified) <= 30_000) {
        badBeats = 0;
        return;
      }
      badBeats += 1;
      if (badBeats === 1) {
        await channel.refreshToken();
        return;
      }
      badBeats = 0;
      onLog(
        `forwarding helper on the runtime is not running (${info ? `its last sign of life is ${Math.round((serverNowMs - Date.parse(info.last_modified)) / 1000)}s old` : `HTTP ${beat.status} for its heartbeat file`}); starting it again`,
      );
      await startHelper();
    } catch (err) {
      if (err instanceof SessionGoneError) {
        if (!goneLogged) onLog(`keep-alive stopped: ${err.message}`);
        goneLogged = true;
        return;
      }
      onLog(`keep-alive failed: ${err.message}`);
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
    // with a fresh token; a runtime that is gone fails the refresh with SessionGoneError.
    await upload().catch(async () => {
      await channel.refreshToken();
      await upload();
    });

    const deadline = Date.now() + (requestTimeoutSeconds + 20) * 1000;
    const startedMs = Date.now();
    let checkedMs = startedMs;
    let helperMissing = false;
    let meta = null;
    let aborted = false;
    res.on("close", () => {
      aborted = !res.writableEnded;
    });
    while (!meta) {
      if (aborted) return;
      if (Date.now() > deadline) {
        jsonReply(res, 504, {
          error: "forward_timeout",
          message: `No response from port ${remotePort} on the runtime within ${requestTimeoutSeconds}s.`,
        });
        return;
      }
      const poll = await channel.fetch(jupyterFilesUrl(channel.baseUrl(), `${root}/res-${id}.json`));
      if (poll.ok) {
        meta = await poll.json();
        break;
      }
      await poll.arrayBuffer().catch(() => {});
      if (Date.now() - checkedMs > 10_000) {
        // A missing response is normal while the service works; a missing helper is not.
        checkedMs = Date.now();
        const beat = await channel.fetch(jupyterFilesUrl(channel.baseUrl(), `${root}/beat`));
        await beat.arrayBuffer().catch(() => {});
        if (!beat.ok) {
          if (helperMissing) {
            throw new Error(`the forwarding helper on the runtime does not answer (HTTP ${beat.status})`);
          }
          helperMissing = true;
          await channel.refreshToken();
        } else {
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
          message: `Could not reach the Colab runtime of session '${sessionName}': ${err?.cause?.code || err.message}. If the runtime was released, start it again and restart 'orca-colab forward'.`,
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
