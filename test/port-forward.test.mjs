import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runForward } from "../bin/commands/forward.mjs";
import { run as runStatus } from "../bin/commands/status.mjs";
import { resolveOAuthClientConfig, saveOAuthCredentials } from "../bin/lib/colab-oauth.mjs";
import { findExecutableOnPath } from "../bin/lib/executable-lookup.mjs";
import { createColabMcpTools } from "../bin/lib/mcp-tools.mjs";
import { startPortForward } from "../bin/lib/port-forward.mjs";
import { deleteSession, readSession, writeSession } from "../bin/lib/session-store.mjs";

const BASE = "https://8080-m.colab.dev";
const python = process.platform === "win32" ? null : findExecutableOnPath("python3");

function tmpDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-colab-forward-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The service on the "runtime": answers like the API a user would forward to.
async function startService(t) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": req.headers.origin,
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"],
      });
      res.end();
    } else if (url.pathname === "/big") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.alloc(Number(url.searchParams.get("n")), "ab"));
    } else if (url.pathname === "/missing") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"detail":"Not Found"}');
    } else {
      res.writeHead(req.method === "POST" ? 201 : 200, { "Content-Type": "application/json", "Set-Cookie": ["a=1", "b=2"] });
      res.end(
        JSON.stringify({
          method: req.method,
          target: req.url,
          host: req.headers.host,
          test: req.headers["x-test"] ?? null,
          contentType: req.headers["content-type"] ?? null,
          bytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return server.address().port;
}

// Jupyter on the runtime, backed by a local directory: the contents API writes files, /files reads them,
// and the terminal command is replaced by starting the real helper with python3.
function fakeRuntime(t, { homeDir, sessionName = "orca-colab-fwd" }) {
  const disk = tmpDir(t);
  const local = (remote) => path.join(disk, ...decodeURIComponent(remote).split("/").filter(Boolean));
  const state = { validToken: "proxy-1", runtimeExists: true, uploadsRefused: 0, helpers: [] };
  writeSession(
    { name: sessionName, createdAt: "2026-11-23T10:00:00.000Z", colabRuntime: { id: "r-1", endpoint: "r-1", baseUrl: BASE, token: "proxy-1" } },
    homeDir,
  );
  saveOAuthCredentials(
    "default",
    { refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, clientId: resolveOAuthClientConfig(homeDir).clientId },
    homeDir,
  );
  const answer = (status, body = "") => new Response(body, { status });
  const fetchImpl = async (url, init = {}) => {
    await new Promise((resolve) => setImmediate(resolve));
    const { origin, pathname } = new URL(url);
    if (origin !== BASE) {
      return state.runtimeExists
        ? answer(200, JSON.stringify({ name: "runtimes/r-1", connectionInfo: { token: state.validToken, url: BASE } }))
        : answer(404, "not found");
    }
    if (init.headers["X-Colab-Runtime-Proxy-Token"] !== state.validToken) {
      if (init.method === "PUT") state.uploadsRefused += 1;
      return answer(404);
    }
    if (pathname.startsWith("/api/contents/")) {
      const file = local(pathname.slice("/api/contents".length));
      if (init.method === "PUT") {
        const model = JSON.parse(init.body);
        const data = Buffer.from(model.content, model.format === "base64" ? "base64" : "utf8");
        mkdirSync(path.dirname(file), { recursive: true });
        if (model.chunk && model.chunk !== 1) appendFileSync(file, data);
        else writeFileSync(file, data);
        return answer(201, "{}");
      }
      return existsSync(file) ? answer(200, JSON.stringify({ last_modified: statSync(file).mtime.toISOString() })) : answer(404);
    }
    const file = local(pathname.slice("/files".length));
    return existsSync(file) ? answer(200, readFileSync(file)) : answer(404);
  };
  const execTty = async ({ command, stdinBase64 }) => {
    const [, root, port, timeout] = command.match(/helper\.py (\S+) (\d+) (\d+)/);
    mkdirSync(local(root), { recursive: true });
    writeFileSync(local(`${root}/helper.py`), Buffer.from(stdinBase64, "base64"));
    const helper = spawn(python, [local(`${root}/helper.py`), local(root), port, timeout], { stdio: "ignore" });
    state.helpers.push(helper);
    t.after(() => helper.kill());
    return { ok: true, exitCode: 0, stdout: "" };
  };
  return { state, fetchImpl, execTty, sessionName };
}

async function forwardTo(t, servicePort, extra = {}) {
  const homeDir = tmpDir(t);
  const runtime = fakeRuntime(t, { homeDir });
  const forward = await startPortForward({
    sessionName: runtime.sessionName,
    remotePort: servicePort,
    listenPort: 0,
    homeDir,
    fetchImpl: runtime.fetchImpl,
    execTty: runtime.execTty,
    pollMs: 10,
    ...extra,
  });
  t.after(() => forward.close());
  return { homeDir, runtime, forward, url: `http://${forward.listen}` };
}

test("forward passes method, path, query, headers, body, status and response headers through unchanged", { skip: !python }, async (t) => {
  const { url, forward } = await forwardTo(t, await startService(t));

  const get = await fetch(`${url}/v1/items?x=1&y=a%20b`, { headers: { "X-Test": "yes" } });
  assert.equal(get.status, 200);
  assert.deepEqual(get.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.deepEqual(await get.json(), {
    method: "GET",
    target: "/v1/items?x=1&y=a%20b",
    host: forward.listen,
    test: "yes",
    contentType: null,
    bytes: 0,
    sha256: createHash("sha256").update("").digest("hex"),
  });

  const body = randomBytes(9 * 1024 * 1024);
  const post = await fetch(`${url}/upload`, { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=xyz" }, body });
  assert.equal(post.status, 201);
  const posted = await post.json();
  assert.deepEqual(
    [posted.method, posted.contentType, posted.bytes, posted.sha256],
    ["POST", "multipart/form-data; boundary=xyz", body.length, createHash("sha256").update(body).digest("hex")],
  );

  const preflight = await fetch(`${url}/v1/gen`, {
    method: "OPTIONS",
    headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");

  const missing = await fetch(`${url}/missing`);
  assert.deepEqual([missing.status, await missing.text()], [404, '{"detail":"Not Found"}']);

  const big = await Promise.all([1, 2, 3, 4].map(() => fetch(`${url}/big?n=3000000`).then((res) => res.arrayBuffer())));
  for (const data of big) {
    assert.equal(Buffer.from(data).equals(Buffer.alloc(3_000_000, "ab")), true);
  }
});

test("forward answers 502 with a JSON body when the port is closed or the session is gone, and recovers from an expired proxy token", { skip: !python }, async (t) => {
  const closedPort = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const dead = await forwardTo(t, closedPort);
  const refused = await fetch(`${dead.url}/x`);
  assert.equal(refused.status, 502);
  assert.equal((await refused.json()).error, "port_unreachable");

  const live = await forwardTo(t, await startService(t));
  live.runtime.state.validToken = "proxy-2";
  const afterExpiry = await fetch(`${live.url}/ok`);
  assert.equal(afterExpiry.status, 200);
  assert.equal(live.runtime.state.uploadsRefused, 1);
  assert.equal(readSession(live.runtime.sessionName, live.homeDir).colabRuntime.token, "proxy-2");

  live.runtime.state.validToken = "nobody-has-this";
  live.runtime.state.runtimeExists = false;
  const released = await fetch(`${live.url}/ok`);
  assert.equal(released.status, 502);
  assert.deepEqual(await released.json(), {
    error: "session_gone",
    message:
      "Colab session 'orca-colab-fwd' is gone (Colab no longer has this runtime). Start it again with 'orca-colab up', start the service on it, and restart 'orca-colab forward'.",
  });

  deleteSession(live.runtime.sessionName, live.homeDir);
  const removed = await fetch(`${live.url}/ok`);
  assert.equal(removed.status, 502);
  assert.match((await removed.json()).message, /no such session on this machine/);
});

test("a running forward is recorded in the session for status and the idle watchdog, and removed when it stops", async (t) => {
  const homeDir = tmpDir(t);
  writeSession(
    { name: "orca-colab-fwd", createdAt: "2026-11-23T10:00:00.000Z", colabRuntime: { id: "r-1", endpoint: "r-1", baseUrl: BASE, token: "proxy-1" } },
    homeDir,
  );
  const controller = new AbortController();
  let out = "";
  const io = { stdout: { write: (c) => { out += c; } }, stderr: { write() {} } };
  const running = runForward(["--port", "8000", "--listen", "127.0.0.1:0", "--timeout", "120"], {
    json: true,
    ...io,
    homeDir,
    signal: controller.signal,
    execTty: async () => ({ ok: true, exitCode: 0, stdout: "" }),
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  while (!out.includes("\n")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const started = JSON.parse(out);
  assert.deepEqual(
    { ...started, listen: started.listen.replace(/\d+$/, "N"), url: started.url.replace(/\d+$/, "N") },
    { ok: true, session: "orca-colab-fwd", remotePort: 8000, listen: "127.0.0.1:N", url: "http://127.0.0.1:N", pid: process.pid },
  );

  let statusOut = "";
  await runStatus([], { json: true, stdout: { write: (c) => { statusOut += c; } }, stderr: io.stderr, homeDir });
  const [session] = JSON.parse(statusOut).sessions;
  assert.deepEqual(session.activePids, [process.pid]);
  assert.deepEqual(session.forwards.map((f) => [f.pid, f.remotePort, f.listen]), [[process.pid, 8000, started.listen]]);

  const stopped = [];
  const tools = createColabMcpTools({ homeDir, stopProcess: (pid) => stopped.push(pid) });
  const stop = await tools.call("forward_stop", { listen: started.listen });
  assert.deepEqual([stop.structuredContent.ok, stop.structuredContent.stopped.session, stopped], [true, "orca-colab-fwd", [process.pid]]);
  assert.match((await tools.call("forward_stop", { pid: 1 })).structuredContent.error, /^No such forward\. Active: pid \d+ on 127\.0\.0\.1:\d+ \(orca-colab-fwd\)\.$/);

  controller.abort();
  assert.equal(await running, 0);
  const after = readSession("orca-colab-fwd", homeDir);
  assert.deepEqual([after.activePids, after.forwards ?? []], [[], []]);

  await assert.rejects(runForward([], { json: true, ...io, homeDir }), /usage: orca-colab forward --port/);
});
