import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getColabPaths, writeConfig } from "../bin/lib/colab-home.mjs";
import { runDoctor } from "../bin/lib/doctor.mjs";
import { parseTailscaleStatus } from "../bin/lib/tailscale-cli.mjs";

const FIXTURE_STATUS_JSON = JSON.stringify({
  BackendState: "Running",
  CurrentTailnet: { Name: "fhq" },
  Self: {
    ID: "nSelf123",
    HostName: "macbook-pro",
    DNSName: "macbook-pro.fhq.ts.net.",
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
    Online: true,
    Active: true,
  },
  Peer: {
    "nodekey:abc": {
      ID: "nPeer1",
      HostName: "orca-colab-9f8e7d",
      DNSName: "orca-colab-9f8e7d.fhq.ts.net.",
      TailscaleIPs: ["100.101.102.200", "fd7a:115c:a1e0::2"],
      Online: true,
      Active: false,
      Tags: ["tag:orca-colab"],
    },
  },
});

test("parseTailscaleStatus extracts BackendState, Self and Peer map from fixture JSON", () => {
  const parsed = parseTailscaleStatus(FIXTURE_STATUS_JSON);
  assert.deepEqual(parsed, {
    backendState: "Running",
    loggedIn: true,
    tailnetName: "fhq",
    self: {
      id: "nSelf123",
      hostName: "macbook-pro",
      dnsName: "macbook-pro.fhq.ts.net.",
      tailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
      ipv4: "100.101.102.103",
      online: true,
      active: true,
      tags: [],
    },
    peers: [
      {
        id: "nPeer1",
        hostName: "orca-colab-9f8e7d",
        dnsName: "orca-colab-9f8e7d.fhq.ts.net.",
        tailscaleIPs: ["100.101.102.200", "fd7a:115c:a1e0::2"],
        ipv4: "100.101.102.200",
        online: true,
        active: false,
        tags: ["tag:orca-colab"],
      },
    ],
  });
});

test("runDoctor reports ok=true when required tools, tailscale and config are present and never leaks authKey", (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-doc-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const secretKey = "tskey-auth-kSecretDoNotLeak999";
  writeConfig(
    {
      authKey: secretKey,
      authKeyCreatedAt: "2026-08-17T00:00:00.000Z",
      accounts: [
        {
          label: "default",
          notebookUrl: "https://colab.research.google.com/drive/1abc",
        },
      ],
    },
    tmpHome,
  );
  const paths = getColabPaths(tmpHome);
  writeFileSync(paths.privateKeyPath, "PRIVATE", { mode: 0o600 });
  writeFileSync(paths.publicKeyPath, "ssh-ed25519 AAAA orca-colab\n", {
    mode: 0o644,
  });

  const fakeBins = {
    ssh: "/usr/bin/ssh",
    "ssh-keygen": "/usr/bin/ssh-keygen",
    git: "/usr/bin/git",
    pbcopy: "/usr/bin/pbcopy",
  };

  const report = runDoctor({
    homeDir: tmpHome,
    platform: "darwin",
    nodeVersion: "22.4.0",
    now: new Date("2026-11-09T00:00:00.000Z"),
    findBinary: (name) => fakeBins[name] ?? null,
    tailscaleStatus: {
      found: true,
      binaryPath: "/usr/local/bin/tailscale",
      ...parseTailscaleStatus(FIXTURE_STATUS_JSON),
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks.config.authKeyAgeDays, 84);
  assert.equal(report.actions.length, 0);
  assert.deepEqual(report.warnings, [
    "Install 'rsync' for fast incremental sync (falling back to 'tar | ssh').",
    "Tailscale auth key is 84 days old (6 day(s) until 90-day expiry); rotate it with 'orca-colab setup'.",
  ]);
  assert.equal(JSON.stringify(report).includes(secretKey), false);
});
