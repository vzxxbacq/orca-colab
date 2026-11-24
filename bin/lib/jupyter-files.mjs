import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { COLAB_HEADERS, COLAB_PROXY_TOKEN_HEADER } from "./colab-api-client.mjs";

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

// 8 MiB of file per request, cut on a base64 quantum; larger bodies are refused by the runtime proxy.
const UPLOAD_CHUNK_BASE64_CHARS = (8 * 1024 * 1024 * 4) / 3 - (((8 * 1024 * 1024 * 4) / 3) % 4);

// Writes a non-hidden file through Jupyter's contents API, in chunks (`chunk: 1, 2, …, -1`).
export async function uploadJupyterFile({ baseUrl, proxyToken, remotePath, contentBase64, fetchImpl = fetch, signal }) {
  const segments = String(remotePath).split("/").filter(Boolean).map((s) => encodeURIComponent(s));
  const url = `${String(baseUrl).replace(/\/+$/, "")}/api/contents/${segments.join("/")}`;
  const count = Math.max(1, Math.ceil(contentBase64.length / UPLOAD_CHUNK_BASE64_CHARS));
  for (let i = 0; i < count; i += 1) {
    const res = await fetchImpl(url, {
      method: "PUT",
      headers: { ...COLAB_HEADERS, [COLAB_PROXY_TOKEN_HEADER]: proxyToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "file",
        format: "base64",
        ...(count > 1 ? { chunk: i === count - 1 ? -1 : i + 1 } : {}),
        content: contentBase64.slice(i * UPLOAD_CHUNK_BASE64_CHARS, (i + 1) * UPLOAD_CHUNK_BASE64_CHARS),
      }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`upload of ${remotePath} failed (${res.status})`);
    }
  }
}
