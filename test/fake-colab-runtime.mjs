// An in-memory stand-in for a Colab runtime's Jupyter server: the contents API, /files with ranges, and
// an `execTty` that plays the job runner. `runJob({ id, script, record, write })` returns the exit code.
export function createFakeRuntime({ baseUrl = "https://8080-m.colab.dev", runJob = async () => 0, exec = null } = {}) {
  const files = new Map();
  const dirs = new Set(["/content"]);
  const requests = [];
  const launches = [];
  const jobs = [];
  let nowMs = Date.parse("2026-11-24T00:00:00.000Z");

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
    text: (p) => files.get(p)?.bytes.toString("utf8") ?? null,
    json: (p) => (files.has(p) ? JSON.parse(files.get(p).bytes.toString("utf8")) : null),
    write: put,
  };
}

export const STATE_DIR = "/content/orca/.orca-colab";
