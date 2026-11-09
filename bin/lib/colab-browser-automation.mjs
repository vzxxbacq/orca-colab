import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const SYSTEM_BROWSERS = [
  "Google Chrome",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
  "Safari",
];

const MACOS_ORCA_FALLBACK = "/Applications/Orca.app/Contents/Resources/bin/orca";

export function locateOrcaBinary(env = process.env, platform = process.platform) {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, platform === "win32" ? "orca.exe" : "orca");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  if (platform === "darwin" && existsSync(MACOS_ORCA_FALLBACK)) {
    return MACOS_ORCA_FALLBACK;
  }
  return null;
}

function runOrcaJson(orcaBin, args, { env = process.env, input = undefined, spawnProcess = spawnSync } = {}) {
  const res = spawnProcess(orcaBin, [...args, "--json"], {
    env,
    input,
    encoding: "utf8",
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    timeout: 12000,
    windowsHide: true,
  });
  if (!res || res.error) {
    return { ok: false, status: res?.status ?? 1, data: null };
  }
  try {
    const parsed = JSON.parse(String(res.stdout ?? "").trim());
    return { ok: res.status === 0 && parsed?.ok !== false, status: res.status ?? 0, data: parsed };
  } catch {
    return { ok: false, status: res.status ?? 1, data: null };
  }
}

export function detectRunningSystemBrowser({
  orcaBin,
  env = process.env,
  spawnProcess = spawnSync,
}) {
  if (!orcaBin) return null;
  const perms = runOrcaJson(orcaBin, ["computer", "permissions"], { env, spawnProcess });
  const hasAccessibility = perms.data?.result?.permissions?.some(
    (p) => p.id === "accessibility" && p.status === "granted",
  );
  if (!hasAccessibility) return null;

  const appsRes = runOrcaJson(orcaBin, ["computer", "list-apps"], { env, spawnProcess });
  const runningNames = new Set(
    (appsRes.data?.result?.apps ?? [])
      .filter((a) => a.isRunning && a.name)
      .map((a) => a.name),
  );
  for (const candidate of SYSTEM_BROWSERS) {
    if (runningNames.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function stepSystemBrowserColab({
  orcaBin,
  appName,
  authKey,
  publicKey,
  loginServer = "",
  hostSuffix = "",
  state = { filled: false, clickedRun: false, clickedConfirm: false },
  env = process.env,
  spawnProcess = spawnSync,
}) {
  const stateRes = runOrcaJson(
    orcaBin,
    ["computer", "get-app-state", "--app", appName, "--no-screenshot"],
    { env, spawnProcess },
  );
  let tree = stateRes.data?.result?.snapshot?.treeText ?? "";
  if (!tree) {
    return { ...state, status: "no-tree" };
  }

  // If the Colab tab is in the background, switch to it first.
  if (!tree.includes("TAILSCALE_AUTH_KEY") && !tree.includes("仍然运行") && !tree.includes("Run anyway")) {
    const tabMatches = [
      ...tree.matchAll(/(\d+)\s+tab \(settable\)[^\n]*orca-colab-bootstrap[^\n]*Value:\s*0/gi),
    ];
    const targetTabIdx = tabMatches.at(-1)?.[1];
    if (targetTabIdx) {
      const clickTab = runOrcaJson(
        orcaBin,
        [
          "computer",
          "click",
          "--app",
          appName,
          "--element-index",
          targetTabIdx,
          "--no-screenshot",
          "--full-tree",
        ],
        { env, spawnProcess },
      );
      tree = clickTab.data?.result?.snapshot?.treeText ?? tree;
    }
  }

  // Check for "Run anyway" / "仍然运行" confirmation dialog first.
  const confirmIdx = tree.match(/(\d+)\s+button (?:仍然运行|Run anyway)/i)?.[1];
  if (confirmIdx && !state.clickedConfirm) {
    const res = runOrcaJson(
      orcaBin,
      ["computer", "click", "--app", appName, "--element-index", confirmIdx, "--no-screenshot"],
      { env, spawnProcess },
    );
    if (res.ok) {
      return { ...state, clickedConfirm: true, status: "clicked-confirm" };
    }
  }

  // If the cell already printed Connected or is currently executing after we filled + clicked, we're done.
  if (
    state.filled &&
    state.clickedRun &&
    (tree.includes("Connected. Keep this tab open.") ||
      tree.includes("正在执行") ||
      tree.includes("Executing"))
  ) {
    return { ...state, done: true, status: "running" };
  }

  const setField = (regex, value) => {
    const idx = tree.match(regex)?.[1];
    if (!idx) return false;
    const res = runOrcaJson(
      orcaBin,
      [
        "computer",
        "set-value",
        "--app",
        appName,
        "--element-index",
        idx,
        "--value-stdin",
        "--no-screenshot",
        "--full-tree",
      ],
      { env, input: value, spawnProcess },
    );
    if (res.ok) {
      tree = res.data?.result?.snapshot?.treeText ?? tree;
      return true;
    }
    return false;
  };

  if (!state.filled && tree.includes("TAILSCALE_AUTH_KEY")) {
    // Reset PASTE if it held raw "" so Colab doesn't fail on raw expression evaluation.
    if (/text field \(settable\) PASTE, Value: ""/.test(tree)) {
      setField(/(\d+)\s+text field \(settable\) PASTE/, '""');
    } else {
      setField(/(\d+)\s+text field \(settable\) PASTE/, "");
    }
    const okAuth = setField(/(\d+)\s+text field \(settable\) TAILSCALE_AUTH_KEY/, authKey);
    const okSsh = setField(/(\d+)\s+text field \(settable\) SSH_PUBLIC_KEY/, publicKey);
    if (loginServer) {
      setField(/(\d+)\s+text field \(settable\) TAILSCALE_LOGIN_SERVER/, loginServer);
    }
    if (hostSuffix) {
      setField(/(\d+)\s+text field \(settable\) HOSTNAME_SUFFIX/, hostSuffix);
    }

    if (okAuth && okSsh) {
      const runIdx = tree.match(/(\d+)\s+button (?:运行单元|Run cell)/i)?.[1];
      if (runIdx) {
        const clickRun = runOrcaJson(
          orcaBin,
          ["computer", "click", "--app", appName, "--element-index", runIdx, "--no-screenshot"],
          { env, spawnProcess },
        );
        return {
          ...state,
          filled: true,
          clickedRun: clickRun.ok,
          status: clickRun.ok ? "filled-and-clicked-run" : "filled",
        };
      }
      return { ...state, filled: true, status: "filled" };
    }
  }

  if (state.filled && !state.clickedRun) {
    const runIdx = tree.match(/(\d+)\s+button (?:运行单元|Run cell)/i)?.[1];
    if (runIdx) {
      const clickRun = runOrcaJson(
        orcaBin,
        ["computer", "click", "--app", appName, "--element-index", runIdx, "--no-screenshot"],
        { env, spawnProcess },
      );
      if (clickRun.ok) {
        return { ...state, clickedRun: true, status: "clicked-run" };
      }
    }
  }

  return { ...state, status: "waiting" };
}
