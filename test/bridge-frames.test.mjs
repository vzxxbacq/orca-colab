import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeFrame,
  FRAME_CHUNK_CHARS,
  FrameAssembler,
} from "../bin/lib/bridge-frames.mjs";

test("frames survive pty wrapping, reordering, duplication and interleaving", () => {
  const noisyText = Array.from({ length: 400 }, (_, i) => ((i * 2654435761) % 1_000_003).toString(36)).join(" ");
  const payloadA = { sessions: [{ name: "orca-colab-60c162", gpu: "T4" }], text: noisyText };
  const payloadB = { ok: true, id: 7 };
  const linesA = encodeFrame("snap", 12, payloadA);
  const linesB = encodeFrame("res", 3, payloadB);
  assert.ok(linesA.length >= 3, `expected several lines, got ${linesA.length}`);
  for (const line of [...linesA, ...linesB]) {
    assert.ok(line.length <= FRAME_CHUNK_CHARS + 32, `line too long: ${line.length}`);
  }

  const wrapped = (line) => `${line.slice(0, 20)}\r\n${line.slice(20)}`;
  const screen = [
    "$ orca-colab watch",
    ...linesB,
    ...linesA.slice(1).reverse(),
    wrapped(linesA[0]).replace("\r\n", ""),
    linesA[1],
    "noise @@OC snap 99 1/1 !!!@@ noise",
  ].join("\n");

  const assembler = new FrameAssembler();
  const first = assembler.ingest(screen);
  assert.deepEqual(
    first.map((f) => [f.kind, f.seq]),
    [["res", 3], ["snap", 12]],
  );
  assert.deepEqual(first[0].payload, payloadB);
  assert.deepEqual(first[1].payload, payloadA);

  const again = assembler.ingest(screen);
  assert.equal(again.length, 0);
});

test("a frame split across two reads is delivered once complete", () => {
  const lines = encodeFrame("log", 1, { output: "step 0 loss 2.31\nstep 50 loss 0.64" });
  const assembler = new FrameAssembler();
  const half = Math.ceil(lines.length / 2);
  assert.equal(assembler.ingest(lines.slice(0, half).join("\n")).length, 0);
  const done = assembler.ingest(lines.slice(half).join("\n"));
  assert.equal(done.length, 1);
  assert.equal(done[0].payload.output.split("\n").length, 2);
});
