import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { findExecutableOnPath } from "./tailscale-cli.mjs";

export const BOOTSTRAP_NOTEBOOK_COLAB_URL =
  "https://colab.research.google.com/github/vzxxbacq/orca-colab/blob/main/notebooks/orca-colab-bootstrap.ipynb";

export function isRunningInsideOrca(env = process.env) {
  return Boolean(
    env?.ORCA_WORKTREE_ID || env?.ORCA_WORKSPACE_ID || env?.ORCA_PANE_KEY,
  );
}

function locateOrcaBinary({
  env = process.env,
  platform = process.platform,
  findBinary = findExecutableOnPath,
} = {}) {
  const names = platform === "linux" ? ["orca-ide", "orca"] : ["orca"];
  for (const name of names) {
    const found = findBinary(name, { env, platform });
    if (found) {
      return found;
    }
  }
  if (
    platform === "darwin" &&
    existsSync("/Applications/Orca.app/Contents/Resources/bin/orca")
  ) {
    return "/Applications/Orca.app/Contents/Resources/bin/orca";
  }
  return null;
}

export function openUrl(
  url,
  {
    env = process.env,
    platform = process.platform,
    systemBrowser = false,
    findBinary = findExecutableOnPath,
    spawnProcess = spawnSync,
  } = {},
) {
  if (!systemBrowser && isRunningInsideOrca(env)) {
    const orcaBin = locateOrcaBinary({ env, platform, findBinary });
    if (orcaBin) {
      try {
        const res = spawnProcess(
          orcaBin,
          ["tab", "create", "--url", url, "--json"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10000,
          },
        );
        if (res && res.status === 0 && !res.error) {
          let browserPageId = null;
          try {
            const parsed = JSON.parse(res.stdout ?? "{}");
            browserPageId = parsed?.browserPageId ?? null;
          } catch {
            // Ignore non-JSON stdout from custom wrappers.
          }
          return {
            opened: true,
            target: "orca-browser",
            browserPageId,
          };
        }
      } catch {
        // Fall through to system browser.
      }
    }
  }

  let command = null;
  let args = [];
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const res = spawnProcess(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    if (res && res.status === 0 && !res.error) {
      return { opened: true, target: "system-browser", browserPageId: null };
    }
  } catch {
    // Graceful fallback when no graphical browser is available.
  }

  return { opened: false, target: null, browserPageId: null };
}

export function openUrlInSystemBrowser(url, opts = {}) {
  return openUrl(url, { ...opts, systemBrowser: true });
}
