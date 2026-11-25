import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRuntime, listRuntimes, stripResourcePrefix } from "./colab-api-client.mjs";
import { getColabPaths } from "./colab-home.mjs";
import { getValidAccessToken, listStoredOAuthAccounts, OAUTH_REAUTH_REQUIRED } from "./colab-oauth.mjs";
import { recordSessionEndEvent, recordSessionStartEvent, resolveDeadSessionEndIso } from "./credit-ledger.mjs";
import { resolveGpuRate } from "./rate-table.mjs";
import { directRuntimeChannel, machineName, readRuntimeSessionRecord, sameMachine } from "./runtime-records.mjs";
import { deleteSession, listSessions, readSession, resolveSession, writeSession } from "./session-store.mjs";
import { listTasks, writeTask } from "./task-store.mjs";

function gpuFromSpec(spec) {
  const accelerator = spec?.accelerator && spec.accelerator !== "NONE" ? spec.accelerator : null;
  return {
    name: spec?.variant === "VARIANT_CPU" || !accelerator ? "Colab CPU" : `NVIDIA ${accelerator}`,
    memoryTotalMiB: null,
    driverVersion: null,
  };
}

function freeSessionName(wanted, runtimeId, taken) {
  if (!taken.has(wanted)) return wanted;
  const suffix = String(runtimeId).replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
  return `${wanted}-${suffix}`;
}

// An `up` on this machine that has its runtime but has not written the session yet.
function upInProgress(homeDir) {
  try {
    const lock = JSON.parse(readFileSync(path.join(getColabPaths(homeDir).baseDir, "assign.lock"), "utf8"));
    process.kill(lock.pid, 0);
    return Date.now() - (lock.ts || 0) < 90_000;
  } catch {
    return false;
  }
}

async function askColabAbout(runtimeId, { accessToken, fetchImpl, getRuntimeFn }) {
  try {
    const runtime = await getRuntimeFn({ runtimeId, accessToken, fetchImpl, signal: AbortSignal.timeout(10_000) });
    return { alive: Boolean(runtime?.connectionInfo?.token), text: null };
  } catch (err) {
    let error = null;
    try {
      error = JSON.parse(err?.responseBody || "null")?.error ?? null;
    } catch {
      // Not JSON: nothing to quote.
    }
    const reasons = (error?.details || []).map((d) => d?.reason).filter((r) => r && r !== "NOT_FOUND");
    const plainNotFound = err?.status === 404 && reasons.length === 0 && (!error?.message || error.message === "Requested entity was not found.");
    return {
      alive: false,
      text: plainNotFound || !err?.status ? null : [err.status, error?.status, ...reasons, error?.message].filter(Boolean).join(" "),
    };
  }
}

// Colab's runtime list is the account's truth, whichever machine started a runtime. Runtimes this
// machine has no session for become sessions here (named and attributed from the record on the
// runtime; "unknown origin" without one), known ones get their fresh proxy token and keep flag, and
// sessions whose runtime Colab no longer lists are dropped. Returns what changed.
export async function discoverAccountRuntimes({
  homeDir = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
  listRuntimesFn = listRuntimes,
  getRuntimeFn = getRuntime,
  nowMs = () => Date.now(),
} = {}) {
  const changes = { adopted: [], dropped: [], accountsListed: [], unreachable: null, reauthRequired: null };
  for (const { account, authenticated, email, reauthError, reauthReason } of listStoredOAuthAccounts(homeDir)) {
    if (!authenticated) {
      // Its runtimes cannot be listed until the owner signs in again; say so instead of looking idle.
      if (reauthError !== "client_changed") {
        changes.reauthRequired ??= `${reauthReason} for account '${account}'${email && email !== account ? ` (${email})` : ""}. Sign in again with 'orca-colab auth login' (tick the Colab permission); no sign-out is needed.`;
      }
      continue;
    }
    const listStartedMs = nowMs();
    let runtimes;
    let accessToken;
    try {
      accessToken = await getValidAccessToken({ account, homeDir, fetchImpl });
      if (!accessToken) continue;
      runtimes = await listRuntimesFn({ accessToken, fetchImpl, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      // Offline or signed out: what this machine already knows stays as it is.
      if (err?.code === "NETWORK_UNREACHABLE") changes.unreachable ??= err.message;
      if (err?.code === OAUTH_REAUTH_REQUIRED) changes.reauthRequired ??= err.message;
      continue;
    }
    changes.accountsListed.push(account);

    // A runtime adopted while its own `up` was still writing the session has two records: the adopted
    // one goes, with an end at its start so the ledger charges the runtime once.
    const ownRuntimeIds = new Set(listSessions(homeDir).filter((s) => !s.adopted && s.colabRuntime?.id).map((s) => s.colabRuntime.id));
    for (const s of listSessions(homeDir)) {
      if (s.adopted && ownRuntimeIds.has(s.colabRuntime?.id) && deleteSession(s.name, homeDir)) {
        recordSessionEndEvent(s, { cause: "duplicate-record", endedAt: s.createdAt, homeDir });
      }
    }
    const sessions = listSessions(homeDir);
    const mine = sessions.filter((s) => (s.account || "default") === account);
    const takenNames = new Set(sessions.map((s) => s.name));
    const listedIds = new Set();

    for (const rt of runtimes) {
      const id = stripResourcePrefix(rt?.name || "", "runtimes/");
      const info = rt?.connectionInfo;
      if (id) listedIds.add(id);
      // Listed without connection details while Colab is still assigning it.
      if (!id || !info?.url || !info?.token) continue;
      const channel = directRuntimeChannel({ baseUrl: info.url, proxyToken: info.token, fetchImpl });
      const record = await readRuntimeSessionRecord(channel).catch(() => undefined);
      const known = mine.find((s) => s.colabRuntime?.id === id);
      if (known) {
        const current = readSession(known.name, homeDir);
        if (!current) continue;
        const keep = record ? record.keep : current.keep;
        // An older orca-colab on this machine rewrites session files without these two fields; the
        // runtime's record puts them back.
        const origin = current.origin || record?.origin || null;
        const adopted = record?.origin ? !sameMachine(record.origin, machineName(env)) : Boolean(current.adopted);
        if (
          current.colabRuntime.token !== info.token ||
          current.colabRuntime.baseUrl !== info.url ||
          current.keep !== keep ||
          current.state === "zombie" ||
          Boolean(current.adopted) !== adopted ||
          Boolean(current.origin) !== Boolean(origin) ||
          (!current.guardrails && Boolean(record?.guardrails))
        ) {
          writeSession(
            {
              ...current,
              keep,
              state: "active",
              origin,
              adopted,
              project: current.project || record?.project || null,
              guardrails: current.guardrails || record?.guardrails || null,
              colabRuntime: {
                ...current.colabRuntime,
                baseUrl: info.url,
                token: info.token,
                tokenExpiry: info.expireTime || current.colabRuntime.tokenExpiry,
              },
            },
            homeDir,
          );
        }
        continue;
      }
      // The record could not be read: the runtime may be ours after all, so wait for a poll that can.
      if (record === undefined) continue;
      // No record yet and an `up` running here: most likely its runtime, about to get its session.
      if (!record && upInProgress(homeDir)) continue;

      const gpu = record?.gpu || gpuFromSpec(rt.runtimeSpec);
      const rate = resolveGpuRate(gpu.name, homeDir);
      const suffix = id.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
      const name = freeSessionName(record?.name || `orca-colab-${suffix}`, id, takenNames);
      takenNames.add(name);
      const createdAt = record?.createdAt || new Date(nowMs()).toISOString();
      const session = writeSession(
        {
          name,
          account,
          hostname: name,
          transport: "colab-tty",
          gpu,
          rateKey: record?.rateKey || rate.rateKey,
          cuPerHour: record?.cuPerHour ?? rate.cuPerHour,
          createdAt,
          lastActivityAt: new Date(nowMs()).toISOString(),
          keep: Boolean(record?.keep),
          state: "active",
          origin: record?.origin || null,
          adopted: true,
          project: record?.project || null,
          guardrails: record?.guardrails || null,
          colabRuntime: {
            id,
            endpoint: info.endpoint || id,
            baseUrl: info.url,
            token: info.token,
            tokenExpiry: info.expireTime || null,
          },
        },
        homeDir,
      );
      recordSessionStartEvent(session, homeDir);
      changes.adopted.push({ name, account, email: email || null, origin: session.origin || null });
    }

    for (const s of mine) {
      // A session written after the list was fetched belongs to an `up` that is finishing right now.
      if (!s.colabRuntime?.id || listedIds.has(s.colabRuntime.id) || !(Date.parse(s.createdAt) < listStartedMs)) {
        continue;
      }
      // The runtime itself is asked before its session is dropped: a list that left it out is no proof,
      // and anything Colab says beyond "not found" is the only reason there will ever be.
      const said = await askColabAbout(s.colabRuntime.id, { accessToken, fetchImpl, getRuntimeFn });
      if (said.alive) continue;
      if (!deleteSession(s.name, homeDir)) continue;
      recordSessionEndEvent(s, { cause: "colab-died", endedAt: resolveDeadSessionEndIso(s, nowMs()), homeDir, colabSaid: said.text });
      for (const t of listTasks(homeDir, { reconcile: false })) {
        if (t.sessionName === s.name && t.status === "running" && t.runtimeBacked) {
          writeTask({ ...t, status: "failed", exitCode: 1, finishedAt: new Date(nowMs()).toISOString(), localPid: null }, homeDir);
        }
      }
      changes.dropped.push({ name: s.name, account });
    }
  }
  return changes;
}

// A session name this machine does not know may be a runtime another machine started; Colab is asked
// once before giving up.
export async function resolveSessionAcrossMachines({ sessionName = null, homeDir = os.homedir(), env = process.env, fetchImpl = fetch } = {}) {
  try {
    return resolveSession({ sessionName, homeDir });
  } catch (err) {
    const changes = await discoverAccountRuntimes({ homeDir, env, fetchImpl }).catch(() => null);
    if (!changes?.adopted.length) throw err;
    return resolveSession({ sessionName, homeDir });
  }
}
