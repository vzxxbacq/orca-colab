import { gunzipSync, gzipSync } from "node:zlib";

// A frame is one JSON payload sent through a pty and read back as screen lines. The pty may wrap,
// repeat or drop lines, so every payload is gzipped, base64-encoded and split into short lines that each
// carry enough header to be reassembled independently of the others.
export const FRAME_PREFIX = "@@OC";
export const FRAME_CHUNK_CHARS = 48;

const LINE_REGEX = /@@OC\s+([a-z]+)\s+(\d+)\s+(\d+)\/(\d+)\s+([A-Za-z0-9+/=]+)@@/g;

export function encodeFrame(kind, seq, payload) {
  if (!/^[a-z]+$/.test(kind)) {
    throw new Error(`frame kind must be lowercase letters: ${kind}`);
  }
  const b64 = gzipSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64");
  const total = Math.max(1, Math.ceil(b64.length / FRAME_CHUNK_CHARS));
  const lines = [];
  for (let i = 0; i < total; i += 1) {
    const chunk = b64.slice(i * FRAME_CHUNK_CHARS, (i + 1) * FRAME_CHUNK_CHARS);
    lines.push(`${FRAME_PREFIX} ${kind} ${seq} ${i + 1}/${total} ${chunk}@@`);
  }
  return lines;
}

export function decodeChunks(chunks) {
  const b64 = chunks.join("");
  return JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString("utf8"));
}

// Keeps partial frames across reads and remembers completed sequence numbers so a frame that stays on
// screen across several reads is delivered once.
export class FrameAssembler {
  constructor({ rememberSeqs = 4096 } = {}) {
    this.partials = new Map();
    this.delivered = new Set();
    this.deliveredOrder = [];
    this.rememberSeqs = rememberSeqs;
  }

  ingest(text) {
    const frames = [];
    const joined = String(text).replace(/\r/g, "");
    LINE_REGEX.lastIndex = 0;
    let match;
    while ((match = LINE_REGEX.exec(joined)) !== null) {
      const [, kind, seqRaw, idxRaw, totalRaw, chunk] = match;
      const seq = Number(seqRaw);
      const key = `${kind}:${seq}`;
      if (this.delivered.has(key)) {
        continue;
      }
      const total = Number(totalRaw);
      let entry = this.partials.get(key);
      if (!entry || entry.total !== total) {
        entry = { kind, seq, total, chunks: new Array(total).fill(null), have: 0 };
        this.partials.set(key, entry);
      }
      const idx = Number(idxRaw) - 1;
      if (idx < 0 || idx >= total || entry.chunks[idx] !== null) {
        continue;
      }
      entry.chunks[idx] = chunk;
      entry.have += 1;
      if (entry.have === total) {
        this.partials.delete(key);
        this.markDelivered(key);
        try {
          frames.push({ kind, seq, payload: decodeChunks(entry.chunks) });
        } catch {
          // A corrupted frame is dropped; the sender repeats state in later frames.
        }
      }
    }
    return frames;
  }

  markDelivered(key) {
    this.delivered.add(key);
    this.deliveredOrder.push(key);
    while (this.deliveredOrder.length > this.rememberSeqs) {
      this.delivered.delete(this.deliveredOrder.shift());
    }
  }
}
