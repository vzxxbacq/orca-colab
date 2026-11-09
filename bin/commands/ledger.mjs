import { EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";

export async function run(_argv, { json, stdout, stderr }) {
  if (json) {
    writeJson({ ok: false, command: "ledger", implemented: false }, stdout);
  } else {
    log("ledger: not yet implemented", stderr);
  }
  return EXIT_OK;
}
