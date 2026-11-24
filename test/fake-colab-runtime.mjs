// An in-memory stand-in for a Colab runtime's Jupyter server: the contents API, /files with ranges, and
// an `execTty` that plays the job runner. `runJob({ id, script, record, write })` returns the exit code.
// `stall({ method, path })` picks requests the proxy never answers. Jupyter sessions and kernels are served
// too, with `FakeWebSocket` as the client side of a kernel's channels: `kernels` shows who is connected.
export function createFakeRuntime({ baseUrl = "https://8080-m.colab.dev", runJob = async () => 0, exec = null, colabRuntimeId = null, stall = null } = {}) {
  const files = new Map();
  const dirs = new Set(["/content"]);
  const requests = [];
  const launches = [];
  const jobs = [];
  let nowMs = Date.parse("2026-11-24T00:00:00.000Z");
  const state = { unreachable: false, proxyToken: "proxy-tok" };
  const kernels = new Map();
  const sockets = [];
  let kernelSeq = 0;
  class FakeWebSocket extends EventTarget {
    constructor(url, { headers = {} } = {}) {
      super();
      this.url = url;
      this.headers = headers;
      this.sent = [];
      this.kernel = kernels.get(/\/api\/kernels\/([^/]+)\/channels/.exec(new URL(url).pathname)?.[1]);
      sockets.push(this);
      queueMicrotask(() => {
        if (!this.kernel || headers["X-Colab-Runtime-Proxy-Token"] !== state.proxyToken || state.unreachable) {
          this.dispatchEvent(new Event("error"));
          this.dispatchEvent(new Event("close"));
          return;
        }
        this.kernel.connections += 1;
        this.open = true;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      if (!this.open) return;
      this.open = false;
      this.kernel.connections -= 1;
      this.dispatchEvent(new Event("close"));
    }
  }
  const spentSignals = new WeakSet();

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { date: new Date(nowMs).toUTCString(), ...headers } });
  const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
  const put = (p, text) => files.set(p, { bytes: Buffer.from(text), mtimeMs: (nowMs += 1000) });
  const model = (p, entry) => ({
    name: p.slice(p.lastIndexOf("/") + 1),
    path: p.slice(1),
    type: entry ? "file" : "directory",
    size: entry ? entry.bytes.length : null,
    last_modified: new Date(entry ? entry.mtimeMs : nowMs).toISOString(),
  });

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method || "GET";
    requests.push({ method, path: u.pathname, headers: init.headers || {} });
    const decoded = decodeURIComponent(u.pathname);
    // Colab's own API: the runtime still exists and hands out its proxy token.
    if (u.hostname === "colaboratory.googleapis.com") {
      return colabRuntimeId && decoded === `/v1beta/runtimes/${colabRuntimeId}`
        ? json(200, { name: `runtimes/${colabRuntimeId}`, connectionInfo: { url: baseUrl, token: state.proxyToken } })
        : json(404, {});
    }
    if (state.unreachable) {
      throw new TypeError("fetch failed");
    }
    // An unanswered request ends when its signal's time is up, and that signal then aborts every later
    // request it is given; no test waits for the time to pass.
    if ((init.signal && spentSignals.has(init.signal)) || stall?.({ method, path: decoded })) {
      if (init.signal) spentSignals.add(init.signal);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (decoded.startsWith("/api/contents/")) {
      const p = decoded.slice("/api/contents".length);
      if (method === "PUT") {
        const body = JSON.parse(init.body);
        if (!dirs.has(parentOf(p))) {
          return json(500, { message: `No such file or directory: '${p}'` });
        }
        if (body.type === "directory") {
          dirs.add(p);
        } else {
          put(p, body.format === "base64" ? Buffer.from(body.content, "base64") : body.content);
        }
        return json(201, model(p, files.get(p)));
      }
      if (method === "DELETE") {
        return files.delete(p) ? new Response(null, { status: 204 }) : json(404, {});
      }
      if (dirs.has(p)) {
        const children = [...files.entries()].filter(([f]) => parentOf(f) === p).map(([f, e]) => model(f, e));
        return json(200, { ...model(p, null), content: children });
      }
      const entry = files.get(p);
      return entry ? json(200, { ...model(p, entry), content: entry.bytes.toString("utf8"), format: "text" }) : json(404, {});
    }
    if (init.headers?.["X-Colab-Runtime-Proxy-Token"] && state.proxyToken !== "proxy-tok" && init.headers["X-Colab-Runtime-Proxy-Token"] !== state.proxyToken) {
      return json(404, {});
    }
    if (decoded === "/api/sessions" && method === "POST") {
      const wanted = JSON.parse(init.body);
      let kernel = [...kernels.values()].find((k) => k.path === wanted.path);
      if (!kernel) {
        kernelSeq += 1;
        kernel = { id: `kernel-${kernelSeq}`, sessionId: `session-${kernelSeq}`, path: wanted.path, connections: 0 };
        kernels.set(kernel.id, kernel);
      }
      return json(201, { id: kernel.sessionId, path: kernel.path, kernel: { id: kernel.id, connections: kernel.connections } });
    }
    if (decoded.startsWith("/api/kernels/") && method === "GET") {
      const kernel = kernels.get(decoded.slice("/api/kernels/".length));
      return kernel ? json(200, { id: kernel.id, connections: kernel.connections }) : json(404, {});
    }
    if (decoded.startsWith("/api/sessions/") && method === "DELETE") {
      const kernel = [...kernels.values()].find((k) => k.sessionId === decoded.slice("/api/sessions/".length));
      if (kernel) kernels.delete(kernel.id);
      return kernel ? new Response(null, { status: 204 }) : json(404, {});
    }
    if (decoded.startsWith("/files/")) {
      const entry = files.get(decoded.slice("/files".length));
      if (!entry) return json(404, {});
      const range = /^bytes=(\d*)-(\d*)$/.exec(init.headers?.Range || "");
      if (!range) return new Response(entry.bytes, { status: 200 });
      const total = entry.bytes.length;
      const from = range[1] === "" ? Math.max(0, total - Number(range[2])) : Number(range[1]);
      if (from >= total) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
      return new Response(entry.bytes.subarray(from), {
        status: 206,
        headers: { "content-range": `bytes ${from}-${total - 1}/${total}` },
      });
    }
    return json(404, {});
  }

  async function execTty(args) {
    const launch = /_job-runner-v1\.py (\S+) (\S+)/.exec(args.command || "");
    if (!launch) {
      return exec ? exec(args) : { ok: true, exitCode: 0, stdout: "" };
    }
    const [, dir, id] = launch;
    launches.push({ id, baseUrl: args.baseUrl, proxyToken: args.proxyToken });
    const script = files.get(`${dir}/${id}.sh`).bytes.toString("utf8");
    files.delete(`${dir}/${id}.sh`);
    const record = JSON.parse(files.get(`${dir}/${id}.json`).bytes.toString("utf8"));
    const save = (patch) => put(`${dir}/${id}.json`, JSON.stringify({ ...record, ...patch, updatedAt: new Date(nowMs).toISOString() }));
    const write = (text) => put(`${dir}/${id}.log`, Buffer.concat([files.get(`${dir}/${id}.log`).bytes, Buffer.from(text)]));
    const stopRequested = () => files.has(`${dir}/${id}.stop`);
    save({ status: "running" });
    jobs.push(
      (async () => {
        const exitCode = await runJob({ id, script, record, write, stopRequested });
        const stopped = stopRequested();
        save({
          status: stopped ? "stopped" : exitCode === 0 ? "succeeded" : "failed",
          exitCode: stopped ? 130 : exitCode,
          finishedAt: new Date(nowMs).toISOString(),
        });
      })(),
    );
    return { ok: true, exitCode: 0, stdout: "started" };
  }

  return {
    baseUrl,
    fetchImpl,
    execTty,
    files,
    dirs,
    requests,
    launches,
    settle: () => Promise.all(jobs),
    advance: (ms) => (nowMs += ms),
    setUnreachable: (value) => (state.unreachable = value),
    FakeWebSocket,
    kernels,
    sockets,
    // Colab hands out a new proxy token; the old one is answered like a missing page.
    rotateProxyToken: (token) => (state.proxyToken = token),
    // Colab takes the runtime back: its API no longer knows it and every connection drops.
    reclaim: () => {
      colabRuntimeId = null;
      state.unreachable = true;
      for (const socket of sockets) socket.close();
    },
    text: (p) => files.get(p)?.bytes.toString("utf8") ?? null,
    json: (p) => (files.has(p) ? JSON.parse(files.get(p).bytes.toString("utf8")) : null),
    write: put,
  };
}

export const STATE_DIR = "/content/orca/.orca-colab";
