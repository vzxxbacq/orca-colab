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
  execCommandOverTty,
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

test("Tailscale-free mode: up and execCommandOverTty work with only Google OAuth and no Tailscale config", async () => {
  const homeDir = makeTempHome();
  try {
    saveOAuthCredentials(
      "default",
      {
        refreshToken: "ref-ts-free",
        accessToken: "valid-ts-free-token",
        expiryDate: Date.now() + 3600_000,
        email: "notailscale@example.com",
      },
      homeDir,
    );

    const upIo = makeBuffers();
    const upCode = await runUp(["--gpu", "T4", "--name", "notail"], {
      json: true,
      stdout: upIo.stdout,
      stderr: upIo.stderr,
      env: {},
      homeDir,
      assignRuntimeFn: async () => ({
        id: "rt-notail-01",
        endpoint: "ep-notail-01",
        baseUrl: "https://8080-rt-notail-01.colab.dev",
        token: "proxy-tok-notail",
        tokenExpiry: "2026-11-09T22:00:00Z",
      }),
      queryGpuTtyFn: async () => ({
        name: "Tesla T4",
        memoryTotalMiB: 15360,
        driverVersion: "550.54.15",
      }),
      nowIso: () => "2026-11-09T12:30:00.000Z",
    });

    assert.equal(upCode, 0);
    const sessionJson = JSON.parse(upIo.stdoutText);
    assert.equal(sessionJson.name, "orca-colab-notail");
    assert.equal(sessionJson.ip, "");
    assert.equal(sessionJson.transport, "colab-tty");
    assert.equal(sessionJson.gpu.name, "Tesla T4");
    assert.equal(sessionJson.cuPerHour, 1.96);

    const chunks = [];
    class FakeExecWebSocket {
      constructor() {
        this.listeners = {};
        setTimeout(() => this.listeners.open?.({}), 5);
      }
      addEventListener(ev, fn) {
        this.listeners[ev] = fn;
      }
      send(raw) {
        const frame = JSON.parse(raw);
        if (typeof frame.data === "string" && frame.data.includes("python3 -u -c")) {
          const b64Match = frame.data.match(/b64decode\("([^"]+)"\)/);
          const pyCode = Buffer.from(b64Match[1], "base64").toString("utf8");
          const cfgMatch = pyCode.match(/b64decode\("([^"]+)"\)/);
          const cfg = JSON.parse(Buffer.from(cfgMatch[1], "base64").toString("utf8"));
          setTimeout(() => {
            this.listeners.message?.({
              data: JSON.stringify({
                data: `\n${cfg.startMarker}\nEpoch 1/1: loss=0.042\n${cfg.endPrefix}0${cfg.endSuffix}\n`,
              }),
            });
          }, 5);
        }
      }
      close() {}
    }

    const execRes = await execCommandOverTty({
      baseUrl: "https://8080-rt-notail-01.colab.dev",
      proxyToken: "proxy-tok-notail",
      command: "python3 train.py",
      WebSocketImpl: FakeExecWebSocket,
      onOutput: (c) => chunks.push(c),
    });

    assert.equal(execRes.ok, true);
    assert.equal(execRes.exitCode, 0);
    assert.equal(execRes.stdout, "Epoch 1/1: loss=0.042");
    assert.equal(chunks.join("").trim(), "Epoch 1/1: loss=0.042");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("Multi-account OAuth supports listing, switching default, and automatic account pool scaling on up --new", async () => {
  const homeDir = makeTempHome();
  try {
    writeConfig(
      {
        accounts: [{ label: "default" }, { label: "acc2@example.com" }],
        defaultAccount: "default",
        maxConcurrentSessions: 1,
      },
      homeDir,
    );

    saveOAuthCredentials(
      "default",
      {
        refreshToken: "ref-acc1",
        accessToken: "tok-acc1",
        expiryDate: Date.now() + 3600_000,
        email: "acc1@example.com",
      },
      homeDir,
    );
    saveOAuthCredentials(
      "acc2@example.com",
      {
        refreshToken: "ref-acc2",
        accessToken: "tok-acc2",
        expiryDate: Date.now() + 3600_000,
        email: "acc2@example.com",
      },
      homeDir,
    );

    const listIo = makeBuffers();
    const listCode = await runAuth(["list"], {
      json: true,
      stdout: listIo.stdout,
      stderr: listIo.stderr,
      homeDir,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            subscriptionTier: "SUBSCRIPTION_TIER_PRO",
            paidComputeUnitsBalance: 50,
            runtimes: [],
          }),
      }),
    });
    assert.equal(listCode, 0);
    const listJson = JSON.parse(listIo.stdoutText);
    assert.equal(listJson.accounts.length, 2);
    assert.equal(listJson.defaultAccount, "default");

    // 1st runtime provisions on default account ("default")
    const up1Io = makeBuffers();
    const up1Code = await runUp(["--gpu", "T4", "--name", "m1"], {
      json: true,
      stdout: up1Io.stdout,
      stderr: up1Io.stderr,
      env: {},
      homeDir,
      assignRuntimeFn: async ({ accessToken }) => {
        assert.equal(accessToken, "tok-acc1");
        return {
          id: "rt-m1",
          endpoint: "ep-m1",
          baseUrl: "https://8080-rt-m1.colab.dev",
          token: "ptok-1",
          tokenExpiry: "2026-11-09T22:00:00Z",
        };
      },
      queryGpuTtyFn: async () => ({
        name: "Tesla T4",
        memoryTotalMiB: 15360,
        driverVersion: "550.54.15",
      }),
    });
    assert.equal(up1Code, 0);
    assert.equal(JSON.parse(up1Io.stdoutText).account, "default");

    // 2nd runtime with --new automatically overflows to "acc2@example.com" since maxConcurrentSessions=1 per account
    const up2Io = makeBuffers();
    const up2Code = await runUp(["--gpu", "T4", "--new", "--name", "m2"], {
      json: true,
      stdout: up2Io.stdout,
      stderr: up2Io.stderr,
      env: {},
      homeDir,
      assignRuntimeFn: async ({ accessToken }) => {
        assert.equal(accessToken, "tok-acc2");
        return {
          id: "rt-m2",
          endpoint: "ep-m2",
          baseUrl: "https://8080-rt-m2.colab.dev",
          token: "ptok-2",
          tokenExpiry: "2026-11-09T22:00:00Z",
        };
      },
      queryGpuTtyFn: async () => ({
        name: "Tesla T4",
        memoryTotalMiB: 15360,
        driverVersion: "550.54.15",
      }),
    });
    assert.equal(up2Code, 0);
    assert.equal(JSON.parse(up2Io.stdoutText).account, "acc2@example.com");

    // Switch default account via CLI
    const swIo = makeBuffers();
    const swCode = await runAuth(["switch", "acc2@example.com"], {
      json: true,
      stdout: swIo.stdout,
      stderr: swIo.stderr,
      homeDir,
    });
    assert.equal(swCode, 0);
    assert.equal(JSON.parse(swIo.stdoutText).defaultAccount, "acc2@example.com");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("Re-running up on the same runtime preserves createdAt and replacing a runtime records session.end so monthly usage does not reset", async () => {
  const homeDir = makeTempHome();
  try {
    saveOAuthCredentials(
      "default",
      {
        refreshToken: "ref-reup",
        accessToken: "valid-reup-token",
        expiryDate: Date.now() + 3600_000,
        email: "reup@example.com",
      },
      homeDir,
    );

    // 1. First runtime started at 10:00Z
    const up1Io = makeBuffers();
    await runUp(["--gpu", "L4", "--name", "decision-api"], {
      json: true,
      stdout: up1Io.stdout,
      stderr: up1Io.stderr,
      env: {},
      homeDir,
      assignRuntimeFn: async () => ({
        id: "rt-l4-first",
        endpoint: "ep-l4-first",
        baseUrl: "https://8080-rt-l4-first.colab.dev",
        token: "ptok-first",
        tokenExpiry: "2026-11-10T11:00:00.000Z",
      }),
      queryGpuTtyFn: async () => ({
        name: "NVIDIA L4",
        memoryTotalMiB: 23034,
        driverVersion: "580.82.07",
      }),
      getConsumptionUserInfoFn: async () => ({
        subscriptionTier: "SUBSCRIPTION_TIER_PRO_PLUS",
        paidComputeUnitsBalance: 100,
        consumptionRateHourly: 1.94,
        assignmentsCount: 1,
      }),
      nowIso: () => "2026-11-10T10:00:00.000Z",
      nowMs: () => Date.parse("2026-11-10T10:00:00.000Z"),
    });
    const s1 = JSON.parse(up1Io.stdoutText);
    assert.equal(s1.createdAt, "2026-11-10T10:00:00.000Z");
    assert.equal(s1.cuPerHour, 1.94);

    // 2. Re-running up 15 minutes later reusing the SAME runtime ID preserves createdAt
    const up2Io = makeBuffers();
    await runUp(["--gpu", "L4", "--name", "decision-api"], {
      json: true,
      stdout: up2Io.stdout,
      stderr: up2Io.stderr,
      env: {},
      homeDir,
      assignRuntimeFn: async () => ({
        id: "rt-l4-first",
        endpoint: "ep-l4-first",
        baseUrl: "https://8080-rt-l4-first.colab.dev",
        token: "ptok-first-refreshed",
        tokenExpiry: "2026-11-10T11:15:00.000Z",
      }),
      queryGpuTtyFn: async () => ({
        name: "NVIDIA L4",
        memoryTotalMiB: 23034,
        driverVersion: "580.82.07",
      }),
      nowIso: () => "2026-11-10T10:15:00.000Z",
      nowMs: () => Date.parse("2026-11-10T10:15:00.000Z"),
    });
    const s2 = JSON.parse(up2Io.stdoutText);
    assert.equal(s2.createdAt, "2026-11-10T10:00:00.000Z");

    // 3. Re-running up at 11:00Z when a NEW runtime ID is assigned closes the first session and keeps its 1.94 CU usage
    const up3Io = makeBuffers();
    await runUp(["--gpu", "L4", "--name", "decision-api"], {
      json: true,
      stdout: up3Io.stdout,
      stderr: up3Io.stderr,
      env: {},
      homeDir,
      assignRuntimeFn: async () => ({
        id: "rt-l4-second",
        endpoint: "ep-l4-second",
        baseUrl: "https://8080-rt-l4-second.colab.dev",
        token: "ptok-second",
        tokenExpiry: "2026-11-10T12:00:00.000Z",
      }),
      queryGpuTtyFn: async () => ({
        name: "NVIDIA L4",
        memoryTotalMiB: 23034,
        driverVersion: "580.82.07",
      }),
      getConsumptionUserInfoFn: async () => ({
        subscriptionTier: "SUBSCRIPTION_TIER_PRO_PLUS",
        paidComputeUnitsBalance: 98.06,
        consumptionRateHourly: 1.94,
        assignmentsCount: 1,
      }),
      nowIso: () => "2026-11-10T11:00:00.000Z",
      nowMs: () => Date.parse("2026-11-10T11:00:00.000Z"),
    });
    const s3 = JSON.parse(up3Io.stdoutText);
    assert.equal(s3.createdAt, "2026-11-10T11:00:00.000Z");

    const credIo = makeBuffers();
    await runCredits([], {
      json: true,
      stdout: credIo.stdout,
      stderr: credIo.stderr,
      homeDir,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            subscriptionTier: "SUBSCRIPTION_TIER_PRO_PLUS",
            paidComputeUnitsBalance: 98.06,
            consumptionRateHourly: 1.94,
            assignmentsCount: 1,
          }),
      }),
      nowIso: () => "2026-11-10T11:00:00.000Z",
      nowMs: () => Date.parse("2026-11-10T11:00:00.000Z"),
    });
    const cred = JSON.parse(credIo.stdoutText);
    assert.equal(cred.estimatedMonthlyUsedCu, 1.94);
    assert.equal(cred.estimatedBalanceCu, 98.06);
    assert.equal(cred.estimatedBurnCuPerHour, 1.94);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
