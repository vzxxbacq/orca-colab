---
name: colab-gpu
description: Set up and use a Google Colab GPU runtime as a remote compute backend through the Google Colab API over the public internet (no VPN or tailnet needed). Trigger when a task needs a GPU or CUDA, model training, fine-tuning, heavy inference that exceeds local laptop resources, or when the user mentions "Colab" or "run this on a GPU".
---

# Colab GPU Compute Backend (`colab-gpu`)

Use disposable Google Colab GPU runtimes directly from the local machine while keeping the workspace, coding agent, and credentials local. See [`references/cli.md`](references/cli.md) for the full command and exit-code table.

## 1. Resolve the CLI

Prefer `orca-colab` if installed on `PATH` (or `node bin/orca-colab.mjs` inside the repo); otherwise run:

```sh
npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/621b5c5e58328fa5e3aa67482f8985290c8f4c3b <command> --json
```

Always pass `--json` and parse **stdout** only (progress and diagnostics go to `stderr` prefixed with `[colab]`).

If this session already has the Colab GPU MCP tools (`doctor`, `auth_login`, `up`, `sync`, `job_submit`, `pull`, `down`, …, served by `orca-colab mcp`), use them instead of the CLI: each tool is one command below with the same options and the same JSON result, the steps are the same, and `auth_login` + `auth_wait` sign the user in without a terminal.

## 2. Resource Discovery & User Guardrails

1. Run `doctor --json`:
   - Run it from the project directory. Inspect `ok`, `mode` (`"direct-api"` or `"unconfigured"`), `checks.oauth`, and `policy` (`allowedGpus`, `maxConcurrentSessions`, and `monthlyBudgetCu` / `autoStopIdleMinutes` when the project sets them).
   - `policy.source` says where the guardrails come from: `"project"` means the project's own file `policy.file` (`<project>/.orca/colab.json`, found by walking up from the current directory) and `"machine"` means this machine's defaults. They are the user's to edit, never yours: do not create, change or delete `.orca/colab.json`, and do not `cd` elsewhere to get other limits. `checks.guardrails.ok === false` means that file is broken; tell the user, nothing starts until it is fixed.
   - If `ok === false`, ask the user to sign in once via `orca-colab auth login` (or click **Sign in with Google** in the Orca Colab panel), ticking the Colab permission on Google's consent page (it starts unticked).
   - **Signing in from another machine**: sign-in ends on `http://127.0.0.1:PORT/...` on the machine that runs `orca-colab`. If the user's browser is on a different machine (a remote server, SSH), that last page will not load, which is expected: ask them to copy its full address from the address bar and run `orca-colab auth redirect <address>` where `orca-colab` runs (or give it to you for it; with the MCP tools, `auth_redirect`). The address is a one-time key to their Colab: it must go nowhere else. On a machine with no browser start with `auth login --no-browser`, which prints the URL to open.
2. Run `status --json` (or `ls --json`) to discover any already-active GPU sessions (`name`, `gpu`, `rateKey`, `cuPerHour`, `reachable`, `ageSeconds`). It lists every runtime of the signed-in Google account, also ones started from another machine: `startedHere: false` with `origin` (machine and agent), or `origin: null` for a runtime of unknown origin (no orca-colab record: an older version, or a notebook the user has open in Colab). You may use any of them by name with `--session`; do not release one you did not start unless the user asks.
3. Run `credits --json` (or `credits calibrate --json`) to check the user's approximate Compute Units balance (`estimatedBalanceCu`) and monthly budget (`budgetCu`, `estimatedMonthlyUsedCu`, `estimatedBudgetUsedPercent`). The budget is a hard limit: at 100 % `up` refuses to start a new runtime. When the project has its own budget, `projectBudget` (`budgetCu`, `estimatedMonthlyUsedCu`) is the one `up` enforces; budgets are counted per project or per machine, not per Google account.

## 3. Resource Management (Provisioning & Scaling Sessions)

1. Choose an accelerator within the user's `policy.allowedGpus` (from `doctor --json`). Prefer `T4` for inference/debugging or `L4` / `A100` for training if allowed by `policy.allowedGpus`.
2. Provision or attach to a runtime:
   - Reuse or start a session: `up --gpu T4 --json` (or `up --gpu auto --json` to pick the default allowed GPU).
   - Start an additional concurrent session (up to `policy.maxConcurrentSessions` on Colab Pro+): `up --gpu L4 --new --name worker2 --json`.
   - If `up` exits `1` with `code: "PROVISIONING_IN_PROGRESS"` (`step: "assign_lock"`), another Agent is currently creating a Colab runtime; wait `retryAfterSeconds` (~15s) and retry `up`.
   - If `up` exits `1` with `step: "budget"` (`code: "BUDGET_REACHED"`), the user's monthly Compute Unit budget is used up (`budgetCu`, `estimatedMonthlyUsedCu`, both estimates). Do not retry and never change the budget on your own: report the figures and let the user raise it in the panel (**Guardrails & CU**) or tell you a number for `credits budget <cu>`. A runtime that is already running can still be reused.
   - If `up` exits `1` with `step: "policy"`, respect the user's hardware guardrail and select from the returned `allowedGpus` list.

## 4. Calling Compute Resources (Sync, Run, and Jobs)

1. **Sync workspace**: `sync [--session N] --json` pushes the current directory (honoring `.gitignore` and `.colabignore`, excluding `.git/`) to `/content/orca/<basename>` and records `remoteRoot`.
2. **Execute GPU tasks (`job submit` or `run`)**:
   - **Managed task (`job submit`)**: `job submit [--session N] --name "Train Model" [--sync] [--wait] --json -- python3 train.py ...` streams live clean output to `~/.orca-colab/tasks/<id>.log` (visible in the Orca Colab panel's **Agent Runs & Live Output** console).
   - **Quick command (`run`)**: `run [--session N] --json -- python3 -c "import torch; ..."` executes directly and returns `{ ok, session, exitCode, stdout, stderr }` (also recorded in the panel's Agent Runs history).
   - **Inspect / manage tasks**: `job ls --json`, `job logs <id> --json`, `job stop <id> --json`.
3. **Pull artifacts**: `pull [--session N] <remotePath> <localDir> --json` downloads a file or directory (checkpoints, weights, metrics) into `<localDir>/<basename>` over HTTPS; binary files arrive intact.
4. **Reach a service on the runtime**: for a one-off query run it from the runtime itself, e.g. `run --json -- curl -s localhost:8000/metrics`. To make an HTTP service there reachable from the local machine, start `forward --port 8000 [--listen 127.0.0.1:8000] --json` in the background (it keeps running and prints one JSON line with `url` once it listens; MCP: `forward_start` / `forward_stop`): requests to `http://127.0.0.1:8000` are replayed against that port on the runtime, about half a second on top each, HTTP only (no WebSockets, no streaming). Never start a tunnel (cloudflared, ngrok, `ssh -R`) on the runtime: Colab takes such runtimes away; a public tunnel, if the user wants one, runs on the local machine in front of the forward.

## 5. Hygiene

- Run `down [--session N | --all] --json` as soon as GPU work is finished so the runtime is unassigned (`DELETE /v1beta/runtimes/<id>`) and stops burning compute units.
- Release the runtimes you started, by name (`down --session <name>`). A runtime another machine is using right now is not released (`reason: "in-use-elsewhere"`, with `inUseBy`): tell the user who is using it and pass `--force` only when they say so.
- Jobs run detached on the runtime with their record and full output under `/content/orca/.orca-colab/tasks/`, so a job keeps running when this session ends and `job ls` / `job logs` / `job stop` work from any machine signed in to the account.
- Colab takes back a runtime it considers unattended. orca-colab stays connected to a runtime while a command of this machine runs (after its first 10 seconds), and the Orca panel or MCP server does for a running job, for 20 minutes after the last command and for a kept session. `status --json` shows `presence.connected` per session; for work longer than a few minutes make sure one of those stays running on a machine that stays on.

## 6. Failure table

| Symptom / Exit code | Likely cause | Action |
|---|---|---|
| `up` exits `1` (`step: "prerequisites"`) | Not signed in to Google, or the Colab permission was not ticked | Ask the user to run `orca-colab auth login` (or use the panel) and tick the Colab permission. |
| `up` exits `1` (`step: "budget"`, `code: "BUDGET_REACHED"`) | Estimated use this month has reached the user's monthly budget; no new runtime is started | Report `estimatedMonthlyUsedCu` / `budgetCu` (estimates) and stop. Only the user raises the budget: in the panel, or by giving you a number for `credits budget <cu>` (`0` removes the limit). Reusing a running session still works. |
| `up` exits `1` (other `step`) | Policy limit or Colab refused the assignment (quota, GPU unavailable) | Read `error`; pick another allowed GPU or wait. `no <GPU> runtime available right now` or `still allocating … withdrawn` means Colab has no free machine of that type and nothing was started: retry in a few minutes or use another allowed GPU. |
| `run` / `sync` / `pull` says the session has no Colab runtime proxy | Session was started by an older orca-colab over Tailscale | Run `down --session <name>` then `up`. |
| Any command fails with `Could not reach <host>: <code> …`, or `status` / `auth status` carry `networkError` | This machine cannot reach Google or Colab: no proxy where one is needed (`No proxy is in use`), or the proxy named in the message is down or refuses the host | Run `doctor --network --json` and report `checks.proxy` and the failing `checks.network.endpoints` (`host`, `causeCode`). The proxy is the user's to set: panel **Setup → Network proxy**, or `--proxy <url>` / `ORCA_COLAB_PROXY`. Do not retry in a loop. |
| Sign-in page says `Google Colab sign-in failed` with `Could not reach …` | Consent succeeded; the token request from this machine did not get out (proxy) | Same as above, then ask the user to sign in again; no restart is needed. |
| `run` / `sync` / `pull` fails with a WebSocket or HTTP error | Colab runtime died or was recycled | Run `status --json`; offer `down` + `up` and re-`sync`. |
| `recentlyEnded` shows `cause: "colab-died"` with `summary` "ended by Colab after about N min" | Colab took the runtime back; it gives no reason. It does this to runtimes it considers unattended (seen 20 to 40 minutes after `up`), whatever is running | Report `summary` and `reason` (`unattendedMinutes` says for how long no client of this machine was connected; `null` = never). Since v0.4.3 a command running longer than 10 s, the Orca panel and the MCP server stay connected to a runtime in use, so keep one of them running for the whole job (`job submit --wait`, `job logs --follow`, or `up --keep` with the panel or MCP server on) and check `presence.connected` in `status --json`. Then `up` and `sync` again. |
| A session is missing from `status` | It ended: released with `down`, stopped by the idle auto-stop, or ended on Colab's side | Read `recentlyEnded` in `status --json` (`endedAt`, `cause`, `reason`) and tell the user which; `up` again and re-`sync` if work remains. |
| A forwarded request answers `502` with `error: "session_gone"` / `"port_unreachable"`, or `504` `"forward_timeout"` | The runtime was released / nothing listens on that port on the runtime / the service took longer than `--timeout` | `up` again, start the service and restart `forward` / start the service on the runtime / raise `--timeout`. |
| Forwarded requests are slow, or `forward` logs `the runtime answers slowly` | The runtime is busy with its disk or network (a large download), so its Jupyter server answers late | Wait: the forward keeps serving and restarts its helper by itself only when the helper's process is gone; a request under way then is run once more. Do not restart `forward` for this. |
| `up` fails with `code: "BUDGET_REACHED"` | The monthly budget is used up: the project's (`scope: "project"`, `file`) or the machine's | Tell the user the figures (`estimatedMonthlyUsedCu` of `budgetCu`, estimates) and which budget it is; only they raise it (`monthlyBudgetCu` in that file, or `credits budget` / the panel for the machine). Reusing a running runtime still works. |
| `down` exits `1` with `reason: "in-use-elsewhere"` or `"use-unknown"` | Another machine has a job or command running on that runtime (`inUseBy`), or the runtime did not answer so that could not be checked | Leave it (retry later for `use-unknown`), or ask the user before `down --session <name> --force`. |
| `down` exits `4` (`reason: "api-delete-failed"`) | The Colab API refused to delete the runtime (sign-in expired, network) | Ask the user to `auth login` and retry `down`, or delete the runtime at colab.research.google.com (`Runtime → Disconnect and delete runtime`). |
