import { EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";

export async function run(_argv, { json, stdout, stderr }) {
  if (json) {
    writeJson({ ok: false, command: "setup", implemented: false }, stdout);
  } else {
    log("setup: not yet implemented", stderr);
  }
  return EXIT_OK;
}
