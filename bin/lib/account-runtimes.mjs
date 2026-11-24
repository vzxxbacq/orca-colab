import os from "node:os";
import { listRuntimes, stripResourcePrefix } from "./colab-api-client.mjs";
import { getValidAccessToken, listOAuthAccounts } from "./colab-oauth.mjs";
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

// Colab's runtime list is the account's truth, whichever machine started a runtime. Runtimes this
// machine has no session for become sessions here (named and attributed from the record on the
// runtime; "unknown origin" without one), known ones get their fresh proxy token and keep flag, and
// sessions whose runtime Colab no longer lists are dropped. Returns what changed.
export async function discoverAccountRuntimes({
  homeDir = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
  listRuntimesFn = listRuntimes,
  nowMs = () => Date.now(),
} = {}) {
  const changes = { adopted: [], dropped: [], accountsListed: [] };
  for (const { account, authenticated, email } of listOAuthAccounts(homeDir)) {
    if (!authenticated) continue;
    const listStartedMs = nowMs();
    let runtimes;
    try {
      const accessToken = await getValidAccessToken({ account, homeDir, fetchImpl });
      if (!accessToken) continue;
      runtimes = await listRuntimesFn({ accessToken, fetchImpl, signal: AbortSignal.timeout(15_000) });
    } catch {
      // Offline or signed out: what this machine already knows stays as it is.
      continue;
    }
    changes.accountsListed.push(account);

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
          Boolean(current.origin) !== Boolean(origin)
        ) {
          writeSession(
            {
              ...current,
              keep,
              state: "active",
              origin,
              adopted,
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
      if (!deleteSession(s.name, homeDir)) continue;
      recordSessionEndEvent(s, { cause: "colab-died", endedAt: resolveDeadSessionEndIso(s, nowMs()), homeDir });
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
