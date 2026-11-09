import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runAuth } from "../bin/commands/auth.mjs";
import { run as runCredits } from "../bin/commands/credits.mjs";
import { run as runDown } from "../bin/commands/down.mjs";
import { run as runUp } from "../bin/commands/up.mjs";
import {
  assignRuntime,
  deleteRuntime,
  getConsumptionUserInfo,
  normalizeRuntimeSpec,
  runBootstrapOverTty,
} from "../bin/lib/colab-api-client.mjs";
import { ensureColabHome, writeConfig } from "../bin/lib/colab-home.mjs";
import {
  generatePkcePair,
  getValidAccessToken,
  readOAuthAccountStatus,
  saveOAuthCredentials,
} from "../bin/lib/colab-oauth.mjs";

function makeTempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "orca-colab-api-test-"));
}

function makeBuffers() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (c) => { out += c; } },
    stderr: { write: (c) => { err += c; } },
    get stdoutText() { return out; },
    get stderrText() { return err; },
  };
}

test("OAuth store saves 0600 credentials, refreshes expired tokens, and never leaks tokens in status", async () => {
  const homeDir = makeTempHome();
  try {
    const pkce = generatePkcePair();
    assert.equal(typeof pkce.codeVerifier, "string");
    assert.equal(typeof pkce.codeChallenge, "string");
    assert.notEqual(pkce.codeVerifier, pkce.codeChallenge);

    const status = saveOAuthCredentials(
      "default",
      {
        refreshToken: "refresh-secret-123",
        accessToken: "expired-access-token",
        expiryDate: 1000,
        email: "researcher@example.com",
        name: "Researcher",
      },
      homeDir,
    );

    assert.equal(status.authenticated, true);
    assert.equal(status.email, "researcher@example.com");
    assert.equal("refreshToken" in status, false);
    assert.equal("accessToken" in status, false);

    const refreshedToken = await getValidAccessToken({
      account: "default",
      homeDir,
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://oauth2.googleapis.com/token");
        assert.match(init.body, /refresh_token=refresh-secret-123/);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "fresh-access-token-456",
            expires_in: 3600,
          }),
        };
      },
    });

    assert.equal(refreshedToken, "fresh-access-token-456");

    const io = makeBuffers();
    const code = await runAuth(["status"], {
      json: true,
      stdout: io.stdout,
      stderr: io.stderr,
      homeDir,
      fetchImpl: async (url) => {
        if (String(url).includes("/v1/user-info")) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                subscriptionTier: "SUBSCRIPTION_TIER_PRO",
                paidComputeUnitsBalance: 88.5,
                consumptionRateHourly: 1.96,
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ runtimes: [{ name: "runtimes/rt-1" }] }),
        };
      },
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(io.stdoutText);
    assert.equal(parsed.authenticated, true);
    assert.equal(parsed.email, "researcher@example.com");
    assert.equal(parsed.subscriptionTier, "SUBSCRIPTION_TIER_PRO");
    assert.equal(parsed.estimatedBalanceCu, 88.5);
    assert.equal(parsed.assignedRuntimesCount, 1);
    assert.equal("accessToken" in parsed, false);
    assert.equal("refreshToken" in parsed, false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("assignRuntime polls operation:wait and runBootstrapOverTty executes over /colab/tty WebSocket", async () => {
  assert.deepEqual(normalizeRuntimeSpec({ gpu: "a100", highRam: true }), {
    variant: "VARIANT_GPU",
    accelerator: "A100",
    shape: "SHAPE_HIGHMEM",
  });

  const assigned = await assignRuntime({
    accessToken: "tok-123",
    gpu: "T4",
    fetchImpl: async (url, init) => {
      if (init.method === "POST" && url.includes("/v1beta/runtimes")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              name: "operations/op-abc",
              done: false,
            }),
        };
      }
      if (url.includes("/v1/operations/op-abc:wait")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              name: "operations/op-abc",
              done: true,
              response: {
                name: "runtimes/m-s-gpu1",
                runtimeSpec: {
                  variant: "VARIANT_GPU",
                  accelerator: "T4",
                  shape: "SHAPE_STANDARD",
                },
                connectionInfo: {
                  endpoint: "m-s-gpu1",
                  url: "https://8080-m-s-gpu1.us-central1.prod.colab.dev",
                  token: "proxy-tok-xyz",
                  expireTime: "2026-11-09T18:00:00Z",
                },
              },
            }),
        };
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  assert.equal(assigned.id, "m-s-gpu1");
  assert.equal(assigned.token, "proxy-tok-xyz");

  const sentFrames = [];
  class FakeWebSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = {};
      setTimeout(() => {
        this.emit("open", {});
      }, 5);
    }
    addEventListener(event, fn) {
      this.listeners[event] = fn;
    }
    emit(event, payload) {
      this.listeners[event]?.(payload);
    }
    send(payload) {
      sentFrames.push(JSON.parse(payload));
      if (sentFrames.length === 2) {
        setTimeout(() => {
          this.emit("message", {
            data: JSON.stringify({
              data: "ORCA_COLAB_BOOTSTRAP_READY ip=100.64.100.22 hostname=orca-colab-direct1\n",
            }),
          });
        }, 5);
      }
    }
    close() {}
  }

  const ttyRes = await runBootstrapOverTty({
    baseUrl: assigned.baseUrl,
    proxyToken: assigned.token,
    authKey: "tskey-auth-test",
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest orca-colab",
    hostnameSuffix: "direct1",
    WebSocketImpl: FakeWebSocket,
  });

  assert.deepEqual(ttyRes, {
    ok: true,
    ip: "100.64.100.22",
    hostname: "orca-colab-direct1",
  });
  assert.equal(sentFrames.length, 2);
});

test("up and down use Direct API without opening a browser when OAuth is connected", async () => {
  const homeDir = makeTempHome();
  try {
    const paths = ensureColabHome(homeDir);
    writeConfig(
      {
        authKey: "tskey-auth-k123456",
        authKeyCreatedAt: "2026-11-09T00:00:00.000Z",
        accounts: [{ label: "default" }],
        defaultAccount: "default",
      },
      homeDir,
    );
    writeFileSync(paths.privateKeyPath, "PRIVATE", { mode: 0o600 });
    writeFileSync(
      paths.publicKeyPath,
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest orca-colab\n",
      { mode: 0o600 },
    );

    saveOAuthCredentials(
      "default",
      {
        refreshToken: "ref-1",
        accessToken: "valid-token",
        expiryDate: Date.now() + 3600_000,
        email: "user@example.com",
      },
      homeDir,
    );

    let browserOpened = false;
    const upIo = makeBuffers();
    const upCode = await runUp(["--gpu", "T4", "--name", "api01"], {
      json: true,
      stdout: upIo.stdout,
      stderr: upIo.stderr,
      env: {},
      homeDir,
      openBrowser: () => {
        browserOpened = true;
      },
      fetchTailscaleStatus: async () => ({
        found: true,
        loggedIn: true,
        backendState: "Running",
        peers: [],
      }),
      assignRuntimeFn: async ({ gpu }) => {
        assert.equal(gpu, "T4");
        return {
          id: "rt-direct-01",
          endpoint: "ep-direct-01",
          baseUrl: "https://8080-rt-direct-01.colab.dev",
          token: "secret-proxy-token",
          tokenExpiry: "2026-11-09T20:00:00Z",
        };
      },
      bootstrapTtyFn: async () => ({
        ok: true,
        hostname: "orca-colab-api01",
        ip: "100.64.100.55",
      }),
      probeSshBanner: async () => ({ ok: true, banner: "SSH-2.0-OpenSSH" }),
      runSsh: () => ({
        status: 0,
        stdout: "Tesla T4, 15360\n",
        stderr: "",
      }),
      nowIso: () => "2026-11-09T12:00:00.000Z",
    });

    assert.equal(upCode, 0);
    assert.equal(browserOpened, false);
    const sessionJson = JSON.parse(upIo.stdoutText);
    assert.equal(sessionJson.name, "orca-colab-api01");
    assert.equal(sessionJson.ip, "100.64.100.55");
    assert.equal(sessionJson.colabRuntime.id, "rt-direct-01");
    assert.equal("token" in sessionJson.colabRuntime, false);

    let deletedRuntimeId = null;
    const downIo = makeBuffers();
    const downCode = await runDown(["--session", "orca-colab-api01"], {
      json: true,
      stdout: downIo.stdout,
      stderr: downIo.stderr,
      homeDir,
      deleteRuntimeFn: async ({ runtimeId }) => {
        deletedRuntimeId = runtimeId;
        return { deleted: true, runtimeId };
      },
      runSsh: () => ({ status: 0, stdout: "", stderr: "" }),
      waitPortClosed: async () => false,
    });

    assert.equal(downCode, 0);
    assert.equal(deletedRuntimeId, "rt-direct-01");
    assert.deepEqual(JSON.parse(downIo.stdoutText), {
      ok: true,
      session: "orca-colab-api01",
      released: true,
    });

    const credIo = makeBuffers();
    const credCode = await runCredits(["calibrate"], {
      json: true,
      stdout: credIo.stdout,
      stderr: credIo.stderr,
      homeDir,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            subscriptionTier: "SUBSCRIPTION_TIER_PRO",
            paidComputeUnitsBalance: 74.25,
            consumptionRateHourly: 1.96,
          }),
      }),
    });
    assert.equal(credCode, 0);
    const credJson = JSON.parse(credIo.stdoutText);
    assert.equal(credJson.estimatedBalanceCu, 74.25);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
