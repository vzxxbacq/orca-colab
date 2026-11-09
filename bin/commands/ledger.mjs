import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { readLedgerEvents } from "../lib/credit-ledger.mjs";

export async function run(argv, { json, stdout, stderr, homeDir }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        month: { type: "string" },
        account: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const { month, account } = parsed.values;
  let events = readLedgerEvents(homeDir);
  if (month) {
    events = events.filter(
      (ev) =>
        (typeof ev.at === "string" && ev.at.startsWith(month)) ||
        (typeof ev.startedAt === "string" && ev.startedAt.startsWith(month)),
    );
  }
  if (account) {
    events = events.filter((ev) => (ev.account ?? "default") === account);
  }

  if (json) {
    writeJson({ events }, stdout);
    return EXIT_OK;
  }

  if (events.length === 0) {
    log("No ledger events.", stderr);
    return EXIT_OK;
  }

  for (const ev of events) {
    log(`${ev.at} [${ev.account ?? "default"}] ${ev.type} ${JSON.stringify(ev)}`, stderr);
  }
  return EXIT_OK;
}
