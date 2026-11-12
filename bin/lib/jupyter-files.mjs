import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { COLAB_PROXY_TOKEN_HEADER } from "./colab-api-client.mjs";

// Every Colab runtime serves Jupyter on the proxy URL, rooted at "/", so /files/<abs path minus the
// leading slash> streams any non-hidden file over plain HTTPS with the runtime proxy token.
export function jupyterFilesUrl(baseUrl, remoteAbsPath) {
  const segments = String(remoteAbsPath)
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s));
  return `${String(baseUrl).replace(/\/+$/, "")}/files/${segments.join("/")}`;
}

export async function downloadJupyterFile({ baseUrl, proxyToken, remotePath, destPath, fetchImpl = fetch, signal }) {
  const url = jupyterFilesUrl(baseUrl, remotePath);
  const res = await fetchImpl(url, { headers: { [COLAB_PROXY_TOKEN_HEADER]: proxyToken }, signal });
  if (!res.ok || !res.body) {
    const text = await res.text?.().catch(() => "");
    throw new Error(`download of ${remotePath} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath, { mode: 0o600 }));
}
