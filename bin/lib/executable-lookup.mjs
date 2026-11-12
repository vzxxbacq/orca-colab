import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

function isExecutableFile(filePath, platform = process.platform) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (platform !== "win32") {
      accessSync(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function findExecutableOnPath(
  name,
  { env = process.env, platform = process.platform } = {},
) {
  const pathEnv = env?.PATH ?? env?.Path ?? "";
  if (!pathEnv) {
    return null;
  }
  const dirs = pathEnv.split(platform === "win32" ? ";" : path.delimiter).filter(Boolean);
  const extensions =
    platform === "win32"
      ? name.toLowerCase().endsWith(".exe")
        ? [""]
        : [".exe", ".cmd", ".bat", ""]
      : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}
