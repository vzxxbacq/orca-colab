import { spawnSync } from "node:child_process";
import { detectClipboardTool } from "./doctor.mjs";
import { findExecutableOnPath } from "./tailscale-cli.mjs";

function clipboardArgsForTool(tool) {
  if (tool === "xclip") {
    return ["-selection", "clipboard"];
  }
  if (tool === "xsel") {
    return ["--clipboard", "--input"];
  }
  return [];
}

export function copyToClipboard(
  text,
  {
    env = process.env,
    platform = process.platform,
    findBinary = findExecutableOnPath,
    spawnProcess = spawnSync,
  } = {},
) {
  const { tool, binaryPath } = detectClipboardTool({
    env,
    platform,
    findBinary,
  });
  if (!binaryPath || !tool) {
    return { copied: false, tool: null };
  }

  try {
    const res = spawnProcess(binaryPath, clipboardArgsForTool(tool), {
      input: String(text),
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5000,
    });
    if (res && res.status === 0 && !res.error) {
      return { copied: true, tool };
    }
  } catch {
    // Graceful fallback when clipboard command fails in headless sessions.
  }
  return { copied: false, tool: null };
}
