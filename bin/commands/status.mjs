import { EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";

export async function run(_argv, { json, stdout, stderr }) {
  if (json) {
    writeJson({ sessions: [] }, stdout);
  } else {
    log("status: not yet implemented", stderr);
  }
  return EXIT_OK;
}
