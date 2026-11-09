import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { waitForSshBanner } from "../bin/lib/ssh-banner-probe.mjs";
import {
  snapshotOnlinePeers,
  waitForColabPeer,
} from "../bin/lib/tailscale-peer-wait.mjs";

test("waitForColabPeer ignores baseline peers and returns new online orca-colab-* peer", async () => {
  const existingPeer = {
    id: "nOld",
    hostName: "orca-colab-old111",
    ipv4: "100.64.0.10",
    online: true,
  };
  const newPeer = {
    id: "nNew",
    hostName: "orca-colab-new222",
    ipv4: "100.64.0.99",
    online: true,
  };

  const baseline = snapshotOnlinePeers([existingPeer]);
  const polls = [
    { peers: [existingPeer, { ...newPeer, online: false }] },
    { peers: [existingPeer, newPeer] },
  ];
  let idx = 0;
  let clock = 1000;

  const found = await waitForColabPeer({
    baselinePeers: baseline,
    fetchStatus: async () => polls[Math.min(idx++, polls.length - 1)],
    deadlineMs: 10_000,
    pollIntervalMs: 3000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  assert.deepEqual(found, newPeer);
});

test("waitForColabPeer throws exitCode=2 timeout when deadline passes", async () => {
  let clock = 1000;
  await assert.rejects(
    () =>
      waitForColabPeer({
        baselinePeers: [],
        fetchStatus: async () => ({ peers: [] }),
        deadlineMs: 4000,
        pollIntervalMs: 3000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    (err) => {
      assert.equal(err.exitCode, 2);
      assert.deepEqual(err.payload, {
        ok: false,
        error: "timed out waiting for a new online orca-colab-* Tailscale peer",
        step: "tailscale-peer",
      });
      return true;
    },
  );
});

test("waitForSshBanner reads SSH- banner from a local TCP server and respects AbortSignal", async (t) => {
  const server = net.createServer((socket) => {
    socket.write("SSH-2.0-OpenSSH_9.2p1 Ubuntu-2ubuntu0.2\r\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const res = await waitForSshBanner({
    host: "127.0.0.1",
    port,
    deadlineMs: Date.now() + 5000,
  });

  assert.deepEqual(res, {
    host: "127.0.0.1",
    port,
    banner: "SSH-2.0-OpenSSH_9.2p1 Ubuntu-2ubuntu0.2",
  });

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      waitForSshBanner({
        host: "127.0.0.1",
        port,
        deadlineMs: Date.now() + 5000,
        signal: ac.signal,
      }),
    (err) => {
      assert.equal(err.exitCode, 3);
      assert.equal(err.payload.step, "ssh-banner");
      return true;
    },
  );
});
