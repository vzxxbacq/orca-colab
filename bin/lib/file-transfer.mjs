import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "../commands/run.mjs";
import { buildSshBaseArgs, buildSshExecArgs } from "./ssh-exec.mjs";
import { findExecutableOnPath } from "./tailscale-cli.mjs";

export function resolveRemoteRoot({
  localPath,
  toDir = null,
  remoteRootBase = "/content/orca",
}) {
  if (toDir && toDir.trim() !== "") {
    return toDir.trim().replace(/\/+$/, "") || "/";
  }
  const baseName = path.basename(path.resolve(localPath)) || "workspace";
  return path.posix.join(remoteRootBase, baseName);
}

export function buildRsyncSshTransport({ homeDir = os.homedir() } = {}) {
  const sshArgs = buildSshBaseArgs({ homeDir }).map(shellQuote).join(" ");
  return `ssh ${sshArgs}`;
}

export function buildSyncRsyncArgs({
  localDir,
  ip,
  remoteRoot,
  homeDir = os.homedir(),
}) {
  const resolvedLocal = `${path.resolve(localDir).replace(/\/+$/, "")}/`;
  const cleanRemote = remoteRoot.replace(/\/+$/, "");
  return [
    "-az",
    "--delete",
    "--exclude=.git/",
    "--filter=:- .gitignore",
    "--filter=:- .colabignore",
    "--rsync-path",
    `mkdir -p ${shellQuote(cleanRemote)} && rsync`,
    "-e",
    buildRsyncSshTransport({ homeDir }),
    resolvedLocal,
    `root@${ip}:${cleanRemote}/`,
  ];
}

export function buildSyncTarPlan({
  localDir,
  ip,
  remoteRoot,
  homeDir = os.homedir(),
  hasGitignore = false,
  hasColabignore = false,
}) {
  const resolvedLocal = path.resolve(localDir);
  const cleanRemote = remoteRoot.replace(/\/+$/, "");
  const tarArgs = ["-czf", "-", "--exclude=.git"];
  if (hasGitignore) {
    tarArgs.push(`--exclude-from=${path.join(resolvedLocal, ".gitignore")}`);
  }
  if (hasColabignore) {
    tarArgs.push(`--exclude-from=${path.join(resolvedLocal, ".colabignore")}`);
  }
  tarArgs.push("-C", resolvedLocal, ".");

  const sshArgs = buildSshExecArgs({
    ip,
    remoteCommand: [
      `mkdir -p ${shellQuote(cleanRemote)} && tar -xzf - -C ${shellQuote(cleanRemote)}`,
    ],
    homeDir,
  });

  return { tarArgs, sshArgs };
}

export function buildPullRsyncArgs({
  ip,
  remotePath,
  localPath,
  homeDir = os.homedir(),
}) {
  return [
    "-az",
    "-e",
    buildRsyncSshTransport({ homeDir }),
    `root@${ip}:${remotePath}`,
    localPath,
  ];
}

export function buildPullTarPlan({
  ip,
  remotePath,
  localPath,
  homeDir = os.homedir(),
}) {
  const cleanRemote = remotePath.replace(/\/+$/, "") || "/";
  const remoteDir = path.posix.dirname(cleanRemote);
  const remoteBase = path.posix.basename(cleanRemote);
  const resolvedLocal = path.resolve(localPath);

  const sshArgs = buildSshExecArgs({
    ip,
    remoteCommand: [
      `tar -czf - -C ${shellQuote(remoteDir)} ${shellQuote(remoteBase)}`,
    ],
    homeDir,
  });
  const tarArgs = ["-xzf", "-", "-C", resolvedLocal];
  return { sshArgs, tarArgs };
}

export function runSyncTransfer({
  localDir,
  ip,
  remoteRoot,
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
  findBinary = findExecutableOnPath,
  spawnProcess = spawnSync,
}) {
  const rsyncBin = findBinary("rsync", { env, platform });
  if (rsyncBin) {
    const args = buildSyncRsyncArgs({ localDir, ip, remoteRoot, homeDir });
    const res = spawnProcess(rsyncBin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: res?.status === 0,
      method: "rsync",
      exitCode: res?.status ?? 1,
      stderr: res?.stderr ?? "",
    };
  }

  const resolvedLocal = path.resolve(localDir);
  const plan = buildSyncTarPlan({
    localDir: resolvedLocal,
    ip,
    remoteRoot,
    homeDir,
    hasGitignore: existsSync(path.join(resolvedLocal, ".gitignore")),
    hasColabignore: existsSync(path.join(resolvedLocal, ".colabignore")),
  });

  const tarRes = spawnProcess("tar", plan.tarArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (tarRes?.status !== 0) {
    return {
      ok: false,
      method: "tar",
      exitCode: tarRes?.status ?? 1,
      stderr: tarRes?.stderr ? tarRes.stderr.toString("utf8") : "tar failed",
    };
  }

  const sshRes = spawnProcess("ssh", plan.sshArgs, {
    input: tarRes.stdout,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    ok: sshRes?.status === 0,
    method: "tar",
    exitCode: sshRes?.status ?? 1,
    stderr: sshRes?.stderr ? sshRes.stderr.toString("utf8") : "",
  };
}

export function runPullTransfer({
  ip,
  remotePath,
  localPath,
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
  findBinary = findExecutableOnPath,
  spawnProcess = spawnSync,
}) {
  const parentDir = path.dirname(path.resolve(localPath));
  mkdirSync(parentDir, { recursive: true });

  const rsyncBin = findBinary("rsync", { env, platform });
  if (rsyncBin) {
    const args = buildPullRsyncArgs({ ip, remotePath, localPath, homeDir });
    const res = spawnProcess(rsyncBin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: res?.status === 0,
      method: "rsync",
      exitCode: res?.status ?? 1,
      stderr: res?.stderr ?? "",
    };
  }

  mkdirSync(path.resolve(localPath), { recursive: true });
  const plan = buildPullTarPlan({ ip, remotePath, localPath, homeDir });
  const sshRes = spawnProcess("ssh", plan.sshArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (sshRes?.status !== 0) {
    return {
      ok: false,
      method: "tar",
      exitCode: sshRes?.status ?? 1,
      stderr: sshRes?.stderr ? sshRes.stderr.toString("utf8") : "ssh tar failed",
    };
  }

  const tarRes = spawnProcess("tar", plan.tarArgs, {
    input: sshRes.stdout,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    ok: tarRes?.status === 0,
    method: "tar",
    exitCode: tarRes?.status ?? 1,
    stderr: tarRes?.stderr ? tarRes.stderr.toString("utf8") : "",
  };
}
