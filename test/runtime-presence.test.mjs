import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOAuthClientConfig, saveOAuthCredentials } from "../bin/lib/colab-oauth.mjs";
import { holdRuntimePresence, presenceOf, RuntimePresenceKeeper, sessionNeedsPresence } from "../bin/lib/runtime-presence.mjs";
import { withSessionActivity } from "../bin/lib/session-activity.mjs";
import { readSession, writeSession } from "../bin/lib/session-store.mjs";
import { createFakeRuntime, STATE_DIR } from "./fake-colab-runtime.mjs";

const BASE = "https://8080-m.colab.dev";

function machine(t, { signedIn = true } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "orca-colab-presence-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (signedIn) {
    saveOAuthCredentials(
      "default",
      { refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, clientId: resolveOAuthClientConfig(home).clientId },
      home,
    );
  }
  writeSession(
    {
      name: "orca-colab-train",
      createdAt: "2026-11-24T08:00:00.000Z",
      transport: "colab-tty",
      colabRuntime: { id: "r-7", endpoint: "r-7", baseUrl: BASE, token: "proxy-tok" },
    },
    home,
  );
  return home;
}

async function until(check, what) {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const hold = (runtime, homeDir, extra = {}) =>
  holdRuntimePresence({ sessionName: "orca-colab-train", homeDir, fetchImpl: runtime.fetchImpl, WebSocketImpl: runtime.FakeWebSocket, retryMs: [5], beatMs: 10, ...extra });

test("a held presence is a websocket on one kernel that every machine shares, removed with the last machine", async (t) => {
  const runtime = createFakeRuntime({ colabRuntimeId: "r-7" });
  const homeA = machine(t);
  const homeB = machine(t);

  const a = hold(runtime, homeA, { nowMs: () => Date.parse("2026-11-24T08:30:00.000Z"), env: { ORCA_COLAB_MACHINE: "machine-A" } });
  await until(() => readSession("orca-colab-train", homeA).lastPresenceAt, "machine A to connect");
  const b = hold(runtime, homeB, { env: { ORCA_COLAB_MACHINE: "machine-B" } });
  await until(() => readSession("orca-colab-train", homeB).lastPresenceAt, "machine B to connect");
  const leases = [...runtime.files.keys()].filter((f) => f.startsWith(`${STATE_DIR}/presence/`)).map((f) => f.slice(`${STATE_DIR}/presence/`.length).replace(/-\d+-[0-9a-f]{8}\.json$/, ""));
  assert.deepEqual(leases.sort(), ["machine-A", "machine-B"]);
  assert.equal(runtime.sockets[0].sent[0].header.msg_type, "kernel_info_request");

  assert.deepEqual([...runtime.kernels.values()], [{ id: "kernel-1", sessionId: "session-1", path: "orca-colab-presence", connections: 2 }]);
  assert.equal(runtime.sockets[0].url.split("?")[0], "wss://8080-m.colab.dev/api/kernels/kernel-1/channels");
  assert.equal(runtime.sockets[0].headers["X-Colab-Runtime-Proxy-Token"], "proxy-tok");
  assert.equal(readSession("orca-colab-train", homeA).lastPresenceAt, "2026-11-24T08:30:00.000Z");
  assert.deepEqual(presenceOf(readSession("orca-colab-train", homeA), Date.parse("2026-11-24T08:31:00.000Z")), {
    connected: true,
    lastAt: "2026-11-24T08:30:00.000Z",
  });
  assert.deepEqual(presenceOf(readSession("orca-colab-train", homeA), Date.parse("2026-11-24T08:40:00.000Z")), {
    connected: false,
    lastAt: "2026-11-24T08:30:00.000Z",
  });

  // Colab's proxy does not tell Jupyter that a client left, so the count is no guide: the leases are.
  await a.close();
  assert.equal(runtime.kernels.size, 1);
  await b.close();
  assert.equal(runtime.kernels.size, 0);
});

test("a dropped presence reconnects with a fresh proxy token, and stops for good once Colab has taken the runtime back", async (t) => {
  const runtime = createFakeRuntime({ colabRuntimeId: "r-7" });
  const home = machine(t);
  const states = [];
  const holder = hold(runtime, home, { onState: (s) => states.push(s.connected ? "connected" : s.gone ? "gone" : "lost") });
  t.after(() => holder.close());
  await until(() => holder.state().connected, "the first connection");

  runtime.rotateProxyToken("proxy-tok-2");
  runtime.sockets[0].close();
  await until(() => runtime.sockets.length === 2 && holder.state().connected, "the reconnection");
  assert.equal(runtime.sockets[1].headers["X-Colab-Runtime-Proxy-Token"], "proxy-tok-2");
  assert.equal(readSession("orca-colab-train", home).colabRuntime.token, "proxy-tok-2");

  // Another holder removed the kernel on leaving; the proxy leaves this websocket looking open.
  runtime.kernels.clear();
  await until(() => runtime.kernels.size === 1 && runtime.sockets.length === 3 && holder.state().connected, "a new kernel");
  assert.deepEqual([...runtime.kernels.keys()], ["kernel-2"]);

  runtime.reclaim();
  await until(() => holder.state().gone, "the holder to give up");
  const attempts = runtime.sockets.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runtime.sockets.length, attempts);
  assert.deepEqual(states, ["connected", "lost", "connected", "lost", "connected", "lost", "gone"]);
});

test("a machine stays connected for kept, busy and recently used sessions only, and never for a runtime without a record", () => {
  const nowMs = Date.parse("2026-11-24T09:00:00.000Z");
  const session = {
    name: "orca-colab-train",
    state: "active",
    keep: false,
    activePids: [],
    createdAt: "2026-11-24T08:00:00.000Z",
    lastActivityAt: "2026-11-24T08:30:00.000Z",
    colabRuntime: { id: "r-7", baseUrl: BASE, token: "proxy-tok" },
  };
  const needs = (patch = {}, extra = {}) => sessionNeedsPresence({ session: { ...session, ...patch }, nowMs, checkPid: (pid) => pid === 4242, ...extra });

  assert.deepEqual(
    {
      unusedFor30Min: needs(),
      usedTenMinAgo: needs({ lastActivityAt: "2026-11-24T08:50:00.000Z" }),
      kept: needs({ keep: true }),
      liveCommand: needs({ activePids: [4242] }),
      deadCommand: needs({ activePids: [7] }),
      runningJob: needs({}, { runningTasksCount: 1 }),
      gpuBusy: needs({}, { gpuBusy: true }),
      longerIdleWindow: needs({}, { activeWithinMinutes: 45 }),
      keptButUnknownOrigin: needs({ keep: true, adopted: true }),
      keptFromAnotherMachine: needs({ keep: true, adopted: true, origin: { machine: "machine-A" } }),
      keptZombie: needs({ keep: true, state: "zombie" }),
    },
    {
      unusedFor30Min: false,
      usedTenMinAgo: true,
      kept: true,
      liveCommand: true,
      deadCommand: false,
      runningJob: true,
      gpuBusy: true,
      longerIdleWindow: true,
      keptButUnknownOrigin: false,
      keptFromAnotherMachine: true,
      keptZombie: false,
    },
  );
});

test("the keeper connects to the sessions that need it and lets go of the others", async (t) => {
  const home = machine(t, { signedIn: false });
  writeSession({ name: "orca-colab-other", createdAt: "2026-11-24T08:00:00.000Z", colabRuntime: { id: "r-8", endpoint: "r-8", baseUrl: BASE, token: "t" } }, home);
  const log = [];
  const keeper = new RuntimePresenceKeeper({
    homeDir: home,
    hold: ({ sessionName }) => {
      log.push(`hold ${sessionName}`);
      return { state: () => ({ gone: false }), close: async () => log.push(`close ${sessionName}`) };
    },
  });

  assert.deepEqual(keeper.reconcile((s) => s.name === "orca-colab-train"), ["orca-colab-train"]);
  keeper.reconcile((s) => s.name === "orca-colab-train");
  keeper.reconcile(() => true);
  keeper.reconcile((s) => s.name === "orca-colab-other");
  // The same name on a new runtime is a new connection.
  writeSession({ ...readSession("orca-colab-other", home), colabRuntime: { id: "r-9", endpoint: "r-9", baseUrl: BASE, token: "t" } }, home);
  keeper.reconcile((s) => s.name === "orca-colab-other");
  await keeper.stop();

  assert.deepEqual(log, [
    "hold orca-colab-train",
    "hold orca-colab-other",
    "close orca-colab-train",
    "close orca-colab-other",
    "hold orca-colab-other",
    "close orca-colab-other",
  ]);
});

test("a command connects to the runtime only once it has run for a while, and disconnects when it ends", async (t) => {
  const home = machine(t, { signedIn: false });
  const log = [];
  const holdPresence = ({ sessionName }) => {
    log.push(`hold ${sessionName}`);
    return { close: async () => log.push("close") };
  };
  const options = { stampRuntime: null, holdPresence, presenceAfterMs: 20 };

  await withSessionActivity("orca-colab-train", home, async () => log.push("short command"), options);
  await withSessionActivity(
    "orca-colab-train",
    home,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      log.push("long command");
    },
    options,
  );

  assert.deepEqual(log, ["short command", "hold orca-colab-train", "long command", "close"]);
});
