import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "../bin/orca-colab.mjs";
import { readConfig, writeConfig } from "../bin/lib/colab-home.mjs";
import { readOAuthStore, resolveOAuthClientConfig, saveOAuthCredentials } from "../bin/lib/colab-oauth.mjs";
import { appendLedgerEvent, readLedgerEvents } from "../bin/lib/credit-ledger.mjs";
import { serveMcpOverStdio } from "../bin/lib/mcp-stdio-server.mjs";
import { CLI_COVERAGE, createColabMcpTools, MCP_INSTRUCTIONS } from "../bin/lib/mcp-tools.mjs";
import { createPanelActions } from "../bin/lib/panel-actions.mjs";
import { listSessions, readSession, writeSession } from "../bin/lib/session-store.mjs";
import { appendTaskLog, readTask, writeTask } from "../bin/lib/task-store.mjs";
import { extractParseArgsOptions } from "../scripts/compat-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = { id: "r-1", endpoint: "r-1", baseUrl: "https://8080-m.colab.dev", token: "proxy-tok", tokenExpiry: null };

function tmpDir(t, prefix = "orca-colab-mcp-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// An MCP client wired to the server in-process: the same line protocol, without a child process.
function connect(t, { homeDir = tmpDir(t), roots = null, ...toolOptions } = {}) {
  const input = new PassThrough();
  const waiting = new Map();
  const lines = [];
  let nextId = 1;
  const tools = createColabMcpTools({ runMain: main, homeDir, env: { PATH: process.env.PATH ?? "" }, ...toolOptions });
  const server = serveMcpOverStdio({
    input,
    write: (line) => {
      lines.push(line);
      const message = JSON.parse(line);
      if (message.method === "roots/list") {
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { roots } })}\n`);
      } else if (message.id !== undefined && !message.method) {
        waiting.get(message.id)?.(message);
      }
    },
    serverInfo: { name: "orca-colab", version: "test" },
    instructions: MCP_INSTRUCTIONS,
    tools: tools.tools,
    callTool: tools.call,
  });
  t.after(async () => {
    input.end();
    await server.closed;
    await tools.settle();
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    });
  return {
    homeDir,
    input,
    lines,
    request,
    initialize: (capabilities = roots ? { roots: {} } : {}) =>
      request("initialize", { protocolVersion: "2025-06-18", capabilities, clientInfo: { name: "t", version: "0" } }),
    call: async (name, args = {}) => (await request("tools/call", { name, arguments: args })).result,
  };
}

function signIn(homeDir) {
  saveOAuthCredentials(
    "default",
    {
      refreshToken: "refresh-secret",
      accessToken: "access-secret",
      expiryDate: Date.now() + 3_600_000,
      email: "u@example.com",
      clientId: resolveOAuthClientConfig(homeDir).clientId,
    },
    homeDir,
  );
}

test("mcp handshake: initialize, ping, tools/list and JSON-RPC errors", async (t) => {
  const client = connect(t);
  const init = await client.initialize();
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, "orca-colab");
  assert.match(init.result.instructions, /Call auth_login/);
  assert.match(init.result.instructions, /tick the Colab permission/);
  assert.match(init.result.instructions, /up with step "budget"/);
  assert.match(init.result.instructions, /the last page \(http:\/\/127\.0\.0\.1:PORT\/\.\.\.\) will not load\. That is expected/);

  const future = await client.request("initialize", { protocolVersion: "2099-01-01", capabilities: {} });
  assert.equal(future.result.protocolVersion, "2025-11-25");

  assert.deepEqual((await client.request("ping")).result, {});
  assert.equal((await client.request("resources/list")).error.code, -32601);
  assert.equal((await client.request("tools/call", { name: "nope", arguments: {} })).error.code, -32602);

  const list = await client.request("tools/list");
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    [
      "doctor", "auth_status", "auth_login", "auth_wait", "auth_redirect", "auth_list", "auth_switch", "auth_logout",
      "status", "up", "sync", "run", "job_submit", "job_list", "job_logs", "job_wait", "job_stop", "pull", "down",
      "forward_start", "forward_stop", "credits", "credits_calibrate", "credits_set", "credits_budget", "ledger", "rates",
    ],
  );
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(typeof tool.description, "string", tool.name);
  }

  client.input.write("not json\n");
  client.input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  await client.request("ping");
  assert.deepEqual(
    client.lines.map((line) => JSON.parse(line)).filter((m) => m.id === null),
    [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }],
  );
});

test("every CLI command and flag is covered by an MCP tool or listed as not exposed", async () => {
  let help = "";
  await main(["--help", "--json"], { stdout: { write: (c) => { help += c; } }, stderr: { write() {} } });
  assert.deepEqual(Object.keys(CLI_COVERAGE).sort(), JSON.parse(help).commands.sort());

  const toolNames = new Set(createColabMcpTools({ runMain: main }).tools.map((tool) => tool.name));
  const covered = new Set();
  for (const file of readdirSync(path.join(REPO_ROOT, "bin", "commands"))) {
    const command = file.replace(/\.mjs$/, "");
    const coverage = CLI_COVERAGE[command];
    const flags = Object.keys(extractParseArgsOptions(readFileSync(path.join(REPO_ROOT, "bin", "commands", file), "utf8")));
    assert.deepEqual(
      [...coverage.flags, ...Object.keys(coverage.notExposed ?? {})].sort(),
      flags.sort(),
      `flags of '${command}'`,
    );
    for (const name of coverage.tools) {
      assert.equal(toolNames.has(name), true, `${command} -> ${name}`);
      covered.add(name);
    }
  }
  assert.deepEqual([...toolNames].sort(), [...covered].sort());
  for (const command of ["watch", "mcp"]) {
    assert.deepEqual(CLI_COVERAGE[command].tools, []);
  }
});

test("without a sign-in, doctor reports and up fails, both naming the auth_login tool", async (t) => {
  const client = connect(t);
  const doctor = await client.call("doctor");
  assert.equal(doctor.isError, false);
  assert.equal(doctor.structuredContent.ok, false);
  assert.equal(doctor.structuredContent.checks.oauth.ok, false);
  assert.match(doctor.structuredContent.hint, /Call the auth_login tool/);
  assert.deepEqual(JSON.parse(doctor.content[0].text), doctor.structuredContent);

  const up = await client.call("up", { gpu: "CPU" });
  assert.equal(up.isError, true);
  assert.equal(up.structuredContent.step, "prerequisites");
  assert.equal(up.structuredContent.exitCode, 1);
  assert.match(up.structuredContent.hint, /Call the auth_login tool/);

  const bad = await client.call("up", { gpu: 4 });
  assert.deepEqual(bad.structuredContent, { ok: false, error: "gpu must be a string" });
});

test("guardrails and budget set in the panel apply to the next MCP call", async (t) => {
  const client = connect(t);
  const panel = createPanelActions({ homeDir: client.homeDir });

  await panel.updatePolicy({ allowedGpus: ["T4"], maxConcurrentSessions: 1 });
  const refused = await client.call("up", { gpu: "A100" });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.step, "policy");
  assert.deepEqual(refused.structuredContent.allowedGpus, ["T4"]);
  assert.deepEqual((await client.call("doctor")).structuredContent.policy.allowedGpus, ["T4"]);

  writeSession({ name: "orca-colab-a", createdAt: "2026-11-09T10:00:00.000Z", colabRuntime: RUNTIME }, client.homeDir);
  const capped = await client.call("up", { gpu: "T4", new: true });
  assert.equal(capped.structuredContent.step, "policy");
  assert.equal(capped.structuredContent.maxConcurrentSessions, 1);

  await panel.setBudget({ budgetCu: 40 });
  assert.equal((await client.call("credits")).structuredContent.budgetCu, 40);

  const now = Date.now();
  appendLedgerEvent(
    { type: "session.start", at: new Date(now - 2 * 3_600_000).toISOString(), session: "orca-colab-b", account: "default", cuPerHour: 30 },
    client.homeDir,
  );
  appendLedgerEvent({ type: "session.end", at: new Date(now).toISOString(), session: "orca-colab-b", account: "default" }, client.homeDir);
  const overBudget = await client.call("up", { gpu: "T4", account: "default", new: true });
  assert.equal(overBudget.structuredContent.step, "policy");
  await panel.updatePolicy({ maxConcurrentSessions: 2 });
  const refusedByBudget = await client.call("up", { gpu: "T4", new: true });
  assert.equal(refusedByBudget.isError, true);
  assert.equal(refusedByBudget.structuredContent.step, "budget");
  assert.equal(refusedByBudget.structuredContent.code, "BUDGET_REACHED");
  assert.equal(refusedByBudget.structuredContent.budgetCu, 40);
  assert.match(refusedByBudget.structuredContent.hint, /^Only the owner can raise the monthly budget/);

  await panel.setBudget({ budgetCu: 100_000 });
  assert.equal((await client.call("up", { gpu: "T4", new: true })).structuredContent.step, "prerequisites");
  assert.deepEqual(readConfig(client.homeDir).allowedGpus, ["T4"]);
});

test("up through MCP writes the session and ledger the panel reads, without the proxy token", async (t) => {
  const homeDir = tmpDir(t);
  signIn(homeDir);
  writeConfig({ allowedGpus: ["T4", "CPU"] }, homeDir);
  const assigned = [];
  const client = connect(t, {
    homeDir,
    commandContext: {
      assignRuntimeFn: async ({ gpu, accessToken }) => {
        assigned.push({ gpu, accessToken });
        return RUNTIME;
      },
      queryGpuTtyFn: async () => ({ name: "Tesla T4", memoryTotalMiB: 15360, driverVersion: "550" }),
    },
  });

  const up = await client.call("up", { gpu: "T4", name: "train", keep: true });
  assert.equal(up.isError, false);
  assert.equal(up.structuredContent.name, "orca-colab-train");
  assert.equal(up.structuredContent.estimatedCuPerHour, 1.96);
  assert.equal(up.content[0].text.includes("proxy-tok"), false);
  assert.deepEqual(assigned, [{ gpu: "T4", accessToken: "access-secret" }]);

  assert.deepEqual(listSessions(homeDir).map((s) => [s.name, s.keep, s.colabRuntime.token]), [["orca-colab-train", true, "proxy-tok"]]);
  assert.deepEqual(readLedgerEvents(homeDir).map((e) => [e.type, e.session]), [["session.start", "orca-colab-train"]]);

  const status = await client.call("status");
  assert.deepEqual(status.structuredContent.sessions.map((s) => [s.name, s.reachable]), [["orca-colab-train", true]]);
  assert.equal(status.content[0].text.includes("proxy-tok"), false);
});

test("sync needs a workspace path and records remoteRoot; run goes through a child CLI process", async (t) => {
  const workspace = tmpDir(t, "orca-colab-ws-");
  const ttyCalls = [];
  const childCalls = [];
  const client = connect(t, {
    commandContext: { spawnProcess: () => ({ status: 0, stdout: Buffer.from("tar-bytes"), stderr: Buffer.alloc(0) }) },
    execTty: async (req) => {
      ttyCalls.push(req);
      return { ok: true, exitCode: 0, stdout: "" };
    },
    runCliChild: async (argv, options) => {
      childCalls.push({ argv, timeoutMs: options.timeoutMs });
      if (argv.includes("sleep 600")) {
        return { pid: process.pid, stdout: "", stderr: "", exitCode: null, timedOut: true, aborted: false };
      }
      return {
        pid: null,
        stdout: `${JSON.stringify({ ok: false, session: "orca-colab-s", exitCode: 3, stdout: "boom\n", stderr: "" })}\n`,
        stderr: "",
        exitCode: 3,
        timedOut: false,
        aborted: false,
      };
    },
  });
  writeSession({ name: "orca-colab-s", createdAt: "2026-11-09T10:00:00.000Z", colabRuntime: RUNTIME }, client.homeDir);

  const noPath = await client.call("sync");
  assert.equal(noPath.isError, true);
  assert.match(noPath.structuredContent.error, /^Pass workspace_path/);
  assert.equal(ttyCalls.length, 0);

  const remoteRoot = `/content/orca/${path.basename(workspace)}`;
  const sync = await client.call("sync", { workspace_path: workspace });
  assert.deepEqual(sync.structuredContent, {
    ok: true,
    session: "orca-colab-s",
    localPath: workspace,
    remoteRoot,
    method: "colab-tty-tar",
  });
  assert.equal(ttyCalls[0].timeoutMs, 900_000);
  assert.equal(readSession("orca-colab-s", client.homeDir).remoteRoot, remoteRoot);

  const run = await client.call("run", {
    argv: ["python", "train.py"],
    session: "orca-colab-s",
    cwd: "/w",
    env: { WANDB_MODE: "offline" },
    timeout_seconds: 20,
  });
  assert.deepEqual(childCalls[0], {
    argv: ["run", "--json", "--session=orca-colab-s", "--cwd=/w", "--env=WANDB_MODE=offline", "--", "python", "train.py"],
    timeoutMs: 20_000,
  });
  assert.equal(run.isError, true);
  assert.deepEqual(run.structuredContent, { ok: false, session: "orca-colab-s", exitCode: 3, stdout: "boom\n", stderr: "" });

  writeTask(
    { id: "task-slow", name: "sleep", command: ["sleep 600"], sessionName: "orca-colab-s", status: "running", localPid: process.pid },
    client.homeDir,
  );
  const slow = await client.call("run", { command: "sleep 600", timeout_seconds: 1 });
  assert.equal(slow.structuredContent.timedOut, true);
  assert.equal(slow.structuredContent.taskId, "task-slow");
  assert.match(slow.structuredContent.hint, /job_wait or job_logs \(id task-slow\)/);

  const both = await client.call("run", { command: "ls", argv: ["ls"] });
  assert.match(both.structuredContent.error, /exactly one of command/);
});

test("job_submit returns at once; job_logs follows by byte offset; job_wait sees the task finish", async (t) => {
  const workspace = tmpDir(t, "orca-colab-ws-");
  const spawned = [];
  const client = connect(t, {
    roots: [{ uri: pathToFileURL(workspace).href, name: "ws" }],
    taskPollMs: 5,
    commandContext: {
      spawnChild: (command, args, options) => {
        spawned.push({ args, cwd: options.cwd, detached: options.detached });
        return { pid: process.pid, unref() {} };
      },
    },
  });
  await client.initialize();
  writeSession({ name: "orca-colab-s", createdAt: "2026-11-09T10:00:00.000Z", colabRuntime: RUNTIME }, client.homeDir);

  const submit = await client.call("job_submit", { command: "python3 train.py", name: "Train", sync: true, env: { A: "1" } });
  const task = submit.structuredContent.task;
  assert.equal(submit.isError, false);
  assert.equal(task.status, "running");
  assert.equal(task.name, "Train");
  assert.deepEqual(task.command, ["python3 train.py"]);
  assert.deepEqual(task.env, { A: "1" });
  assert.equal(task.syncPath, workspace);
  assert.deepEqual(spawned.map((s) => [s.args.slice(1, 4), s.cwd, s.detached]), [[["job", "--internal-exec", task.id], workspace, true]]);

  appendTaskLog(task.id, "epoch 1\n", client.homeDir);
  const first = await client.call("job_logs", { id: task.id, since_bytes: 0 });
  assert.equal(first.structuredContent.output, "epoch 1\n");
  assert.equal(first.structuredContent.nextSinceBytes, 8);
  appendTaskLog(task.id, "epoch 2\n", client.homeDir);
  const second = await client.call("job_logs", { id: task.id, since_bytes: 8 });
  assert.equal(second.structuredContent.output, "epoch 2\n");
  assert.equal(second.structuredContent.nextSinceBytes, 16);
  assert.equal((await client.call("job_logs", { id: task.id })).structuredContent.nextSinceBytes, 16);

  setTimeout(() => {
    writeTask({ ...readTask(task.id, client.homeDir), status: "succeeded", exitCode: 0 }, client.homeDir);
  }, 30);
  const waited = await client.call("job_wait", { id: task.id, timeout_seconds: 20 });
  assert.equal(waited.structuredContent.finished, true);
  assert.equal(waited.structuredContent.task.status, "succeeded");
  assert.equal(waited.structuredContent.output, "epoch 1\nepoch 2\n");

  const list = await client.call("job_list", { status: "succeeded" });
  assert.deepEqual(list.structuredContent.tasks.map((x) => x.id), [task.id]);
  assert.equal((await client.call("job_logs", { id: "../x" })).structuredContent.error, "invalid task id: ../x");
});

const REMOTE_BROWSER_NOTE =
  "If the browser is on another machine than orca-colab, the last page (http://127.0.0.1:PORT/...) will not load. That is expected: copy its full address from the address bar and give it to you for the auth_redirect tool. That address is a one-time key to the Colab account; send it nowhere else.";

function googleFetch(scope) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, scope, email: "owner@example.com" }),
  });
}

function approveInBrowser(url) {
  const redirect = new URL(url).searchParams.get("redirect_uri");
  const state = new URL(url).searchParams.get("state");
  return fetch(`${redirect}/?state=${encodeURIComponent(state)}&code=c`);
}

test("auth_login returns the URL at once and auth_wait reports the finished sign-in", async (t) => {
  const opened = [];
  const client = connect(t, {
    openBrowser: (url) => {
      opened.push(url);
      return { opened: true };
    },
    commandContext: { fetchImpl: googleFetch("openid https://www.googleapis.com/auth/colaboratory") },
  });

  assert.equal((await client.call("auth_wait", { timeout_seconds: 1 })).structuredContent.state, "not_started");

  const login = await client.call("auth_login");
  assert.equal(login.isError, false);
  assert.equal(login.structuredContent.state, "waiting_for_owner");
  assert.equal(login.structuredContent.browserOpened, true);
  assert.match(login.structuredContent.url, /^https:\/\/accounts\.google\.com\//);
  assert.match(login.structuredContent.next, /tick the Colab permission/);
  assert.equal(login.structuredContent.next.includes(REMOTE_BROWSER_NOTE), true);
  assert.equal(login.structuredContent.alreadyPending, undefined);
  assert.deepEqual(opened, [login.structuredContent.url]);

  const again = await client.call("auth_login", { open_browser: false });
  assert.equal(again.structuredContent.url, login.structuredContent.url);
  assert.equal(again.structuredContent.alreadyPending, true);
  assert.match(
    again.structuredContent.note,
    /^A sign-in started \d+s ago is still waiting; this is the same one \(same url\), not a new one\. Its page was already opened in a browser on this machine when it started\.$/,
  );
  assert.equal(opened.length, 1);
  const waiting = await client.call("auth_wait", { timeout_seconds: 1 });
  assert.equal(waiting.structuredContent.next.includes(REMOTE_BROWSER_NOTE), true);
  assert.equal((await client.call("auth_status")).structuredContent.signIn.state, "waiting_for_owner");

  assert.equal((await approveInBrowser(login.structuredContent.url)).status, 200);
  const done = await client.call("auth_wait", { timeout_seconds: 20 });
  assert.equal(done.structuredContent.state, "signed_in");
  assert.equal(done.structuredContent.email, "owner@example.com");
  assert.equal(done.content[0].text.includes("secret"), false);
  assert.equal(readOAuthStore(client.homeDir).accounts.default.refreshToken, "refresh-secret");
  assert.equal(readConfig(client.homeDir).defaultAccount, "default");
  assert.equal((await client.call("doctor")).structuredContent.checks.oauth.ok, true);
});

test("a sign-in with the Colab permission left unticked fails with a hint, and no browser means auth_redirect", async (t) => {
  const opened = [];
  const client = connect(t, {
    openBrowser: (url) => {
      opened.push(url);
      return { opened: false };
    },
    commandContext: { fetchImpl: googleFetch("openid") },
  });

  const login = await client.call("auth_login", { open_browser: false });
  assert.equal(login.structuredContent.browserOpened, false);
  assert.match(login.structuredContent.next, /^No browser was opened\. Give the owner the url/);
  assert.equal(login.structuredContent.next.includes(REMOTE_BROWSER_NOTE), true);
  assert.equal(opened.length, 0);
  // Asking for a browser now opens the page of the sign-in that is already waiting.
  const reopened = await client.call("auth_login");
  assert.equal(reopened.structuredContent.alreadyPending, true);
  assert.equal(reopened.structuredContent.url, login.structuredContent.url);
  assert.deepEqual(opened, [login.structuredContent.url]);

  const redirect = new URL(login.structuredContent.url).searchParams.get("redirect_uri");
  const state = new URL(login.structuredContent.url).searchParams.get("state");
  assert.equal((await client.call("auth_redirect", { url: "https://evil.example/?code=c" })).isError, true);
  // The real fetch delivers the redirect to the loopback server, which answers 403 for the missing scope.
  const delivered = await createColabMcpTools({ runMain: main, homeDir: client.homeDir }).call("auth_redirect", {
    url: `${redirect}/?state=${encodeURIComponent(state)}&code=c`,
  });
  assert.match(delivered.structuredContent.error, /HTTP 403/);

  const failed = await client.call("auth_wait", { timeout_seconds: 20 });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.state, "failed");
  assert.match(failed.structuredContent.hint, /left the Colab permission unticked/);
  assert.deepEqual(readOAuthStore(client.homeDir).accounts, {});
});

test("orca-colab mcp writes only JSON-RPC messages to stdout", async (t) => {
  const homeDir = tmpDir(t);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "bin", "orca-colab.mjs"), "mcp"], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/call", params: { name: "doctor", arguments: {} } });
  send({ id: 3, method: "tools/call", params: { name: "status", arguments: {} } });
  send({ id: 4, method: "tools/call", params: { name: "up", arguments: { gpu: "CPU" } } });
  const answered = () => stdout.split("\n").filter(Boolean).length;
  while (answered() < 4) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(exitCode, 0);
  const messages = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((m) => [m.jsonrpc, m.id]).sort((a, b) => a[1] - b[1]), [["2.0", 1], ["2.0", 2], ["2.0", 3], ["2.0", 4]]);
  assert.equal(messages.find((m) => m.id === 1).result.protocolVersion, "2024-11-05");
  assert.equal(messages.find((m) => m.id === 4).result.structuredContent.step, "prerequisites");
  assert.match(stderr, /^\[colab\] MCP server ready on stdio/);
});
