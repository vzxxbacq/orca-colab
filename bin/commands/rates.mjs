import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { readRateTable, setRateOverride } from "../lib/rate-table.mjs";

export async function run(argv, { json, stdout, stderr, homeDir }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        set: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const setList = parsed.values.set ?? [];
  for (const item of setList) {
    const eq = item.indexOf("=");
    if (eq <= 0) {
      throw new CliError(
        `invalid --set value '${item}' (expected KEY=CU_PER_HOUR)`,
      );
    }
    const key = item.slice(0, eq).trim();
    const val = Number(item.slice(eq + 1).trim());
    setRateOverride(key, val, homeDir);
  }

  const rates = readRateTable(homeDir);
  if (json) {
    writeJson({ approximate: true, rates }, stdout);
    return EXIT_OK;
  }

  log("Approximate compute-unit rates (CU/hour):", stderr);
  for (const [key, rate] of Object.entries(rates)) {
    log(`  ${key}: ≈ ${rate} CU/h`, stderr);
  }
  return EXIT_OK;
}
