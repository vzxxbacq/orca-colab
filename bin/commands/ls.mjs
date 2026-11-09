import { run as runStatus } from "./status.mjs";

export async function run(argv, context) {
  return runStatus(argv, context);
}
