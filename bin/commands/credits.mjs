import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { readConfig } from "../lib/colab-home.mjs";
import {
  projectAccountCredits,
  readLedgerEvents,
  recordBudgetSetEvent,
  recordCalibrateEvent,
} from "../lib/credit-ledger.mjs";
import { listSessions } from "../lib/session-store.mjs";

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    homeDir,
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        account: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const config = readConfig(homeDir);
  const account =
    parsed.values.account?.trim() || config?.defaultAccount || "default";
  const [subcommand, rawValue] = parsed.positionals;

  if (subcommand === "set") {
    const balanceCu = Number(rawValue);
    if (rawValue === undefined || !Number.isFinite(balanceCu) || balanceCu < 0) {
      throw new CliError("usage: orca-colab credits set <cu> [--account A]");
    }
    recordCalibrateEvent(
      { account, balanceCu, source: "manual", at: nowIso() },
      homeDir,
    );
  } else if (subcommand === "budget") {
    const budgetCu = Number(rawValue);
    if (rawValue === undefined || !Number.isFinite(budgetCu) || budgetCu < 0) {
      throw new CliError("usage: orca-colab credits budget <cu> [--account A]");
    }
    recordBudgetSetEvent({ account, budgetCu, at: nowIso() }, homeDir);
  } else if (subcommand !== undefined) {
    throw new CliError(
      `unknown credits subcommand '${subcommand}' (expected 'set' or 'budget')`,
    );
  }

  const events = readLedgerEvents(homeDir);
  const activeSessions = listSessions(homeDir);
  const projection = projectAccountCredits({
    events,
    activeSessions,
    account,
    nowMs: nowMs(),
  });

  if (json) {
    writeJson(projection, stdout);
    return EXIT_OK;
  }

  const balText =
    projection.estimatedBalanceCu !== null
      ? `≈ ${projection.estimatedBalanceCu} CU (calibrated ${projection.calibrationAgeSeconds ?? 0}s ago)`
      : "uncalibrated (run 'orca-colab credits set <cu>')";
  log(
    `Account '${projection.account}' (approximate): balance ${balText}, burn ≈ ${projection.estimatedBurnCuPerHour} CU/h, month used ≈ ${projection.estimatedMonthlyUsedCu} CU${projection.budgetCu !== null ? ` / budget ${projection.budgetCu} CU` : ""}`,
    stderr,
  );
  return EXIT_OK;
}
