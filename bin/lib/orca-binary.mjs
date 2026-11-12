import { existsSync } from "node:fs";
import path from "node:path";

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
