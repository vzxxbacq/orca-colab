import os from "node:os";
import { CliError } from "./cli-output.mjs";
import {
  ensureColabHome,
  getColabPaths,
  readJsonFile,
  writeJsonAtomic,
} from "./colab-home.mjs";

export const DEFAULT_RATE_TABLE = Object.freeze({
  T4: 1.96,
  L4: 4.82,
  A100: 11.77,
  "TPU v2-8": 1.76,
  CPU: 0.08,
  unknown: 2,
});

export function mapGpuNameToRateKey(gpuName) {
  const raw = String(gpuName ?? "").trim();
  const upper = raw.toUpperCase();
  if (!upper || upper === "CPU") {
    return "CPU";
  }
  if (upper.includes("T4")) {
    return "T4";
  }
  if (upper.includes("L4")) {
    return "L4";
  }
  if (upper.includes("A100")) {
    return "A100";
  }
  if (upper.includes("TPU")) {
    return "TPU v2-8";
  }
  return "unknown";
}

export function readRateOverrides(homeDir = os.homedir()) {
  const { ratesPath } = getColabPaths(homeDir);
  const raw = readJsonFile(ratesPath);
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const overrides = {};
  for (const [key, val] of Object.entries(raw)) {
    const num = Number(val);
    if (Number.isFinite(num) && num >= 0) {
      overrides[key] = num;
    }
  }
  return overrides;
}

export function readRateTable(homeDir = os.homedir()) {
  const overrides = readRateOverrides(homeDir);
  return {
    ...DEFAULT_RATE_TABLE,
    ...overrides,
  };
}

export function setRateOverride(key, cuPerHour, homeDir = os.homedir()) {
  const cleanKey = String(key ?? "").trim();
  const num = Number(cuPerHour);
  if (!cleanKey || !Number.isFinite(num) || num < 0) {
    throw new CliError(`invalid rate override: ${key}=${cuPerHour}`);
  }
  const { ratesPath } = ensureColabHome(homeDir);
  const current = readRateOverrides(homeDir);
  const next = {
    ...current,
    [cleanKey]: num,
  };
  writeJsonAtomic(ratesPath, next, { mode: 0o600 });
  return {
    ...DEFAULT_RATE_TABLE,
    ...next,
  };
}

export function resolveGpuRate(gpuName, homeDir = os.homedir()) {
  const table = readRateTable(homeDir);
  const trimmed = String(gpuName ?? "").trim();
  if (trimmed && Object.hasOwn(table, trimmed)) {
    return { rateKey: trimmed, cuPerHour: table[trimmed] };
  }
  const rateKey = mapGpuNameToRateKey(gpuName);
  const cuPerHour = table[rateKey] ?? table.unknown ?? DEFAULT_RATE_TABLE.unknown;
  return { rateKey, cuPerHour };
}
