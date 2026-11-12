import path from "node:path";

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
