---
name: colab-gpu
description: Set up and use a Google Colab GPU runtime as a remote compute backend via Google Colab Direct API (or optional Tailscale SSH). Trigger when a task needs a GPU or CUDA, model training, fine-tuning, heavy inference that exceeds local laptop resources, or when the user mentions "Colab" or "run this on a GPU".
---

# Colab GPU Compute Backend (`colab-gpu`)

Use disposable Google Colab GPU runtimes directly from the local machine while keeping the workspace, coding agent, and credentials local. See [`references/cli.md`](references/cli.md) for the full command and exit-code table.

## 1. Resolve the CLI

Prefer `orca-colab` if installed on `PATH` (or `node bin/orca-colab.mjs` inside the repo); otherwise run:

```sh
npx -y github:vzxxbacq/orca-colab#v0.2.4 <command> --json
```

Always pass `--json` and parse **stdout** only (progress and diagnostics go to `stderr` prefixed with `[colab]`).

## 2. Resource Discovery & User Guardrails

1. Run `doctor --json`:
   - Inspect `ok`, `mode` (`"direct-api"` or `"tailscale-ssh"`), `checks.oauth`, and `policy` (`allowedGpus`, `maxConcurrentSessions`).
   - If `ok === false`, ask the user to sign in once via `orca-colab auth login` (or click **Sign in with Google** in the Orca Colab panel). No Tailscale setup is required in Direct API mode.
2. Run `status --json` (or `ls --json`) to discover any already-active GPU sessions (`name`, `gpu`, `rateKey`, `cuPerHour`, `reachable`, `ageSeconds`).
3. Run `credits --json` (or `credits calibrate --json`) to check the user's approximate Compute Units balance (`estimatedBalanceCu`) and monthly budget (`budgetCu`, `estimatedBudgetUsedPercent`).

## 3. Resource Management (Provisioning & Scaling Sessions)

1. Choose an accelerator within the user's `policy.allowedGpus` (from `doctor --json`). Prefer `T4` for inference/debugging or `L4` / `A100` for training if allowed by `policy.allowedGpus`.
2. Provision or attach to a runtime:
   - Reuse or start a session: `up --gpu T4 --json` (or `up --gpu auto --json` to pick the default allowed GPU).
   - Start an additional concurrent session (up to `policy.maxConcurrentSessions` on Colab Pro+): `up --gpu L4 --new --name worker2 --json`.
   - If `up` exits `1` with `code: "PROVISIONING_IN_PROGRESS"` (`step: "assign_lock"`), another Agent is currently creating a Colab runtime; wait `retryAfterSeconds` (~15s) and retry `up`.
   - If `up` exits `1` with `step: "policy"`, respect the user's hardware guardrail and select from the returned `allowedGpus` list.

## 4. Calling Compute Resources (Sync, Run, and Jobs)

1. **Sync workspace**: `sync [--session N] --json` pushes the current directory (honoring `.gitignore` and `.colabignore`, excluding `.git/`) to `/content/orca/<basename>` and records `remoteRoot`.
2. **Execute GPU tasks (`job submit` or `run`)**:
   - **Managed task (`job submit`)**: `job submit [--session N] --name "Train Model" [--sync] [--wait] --json -- python3 train.py ...` streams live clean output to `~/.orca-colab/tasks/<id>.log` (visible in the Orca Colab panel's **Agent Runs & Live Output** console).
   - **Quick command (`run`)**: `run [--session N] --json -- python3 -c "import torch; ..."` executes directly and returns `{ ok, session, exitCode, stdout, stderr }` (also recorded in the panel's Agent Runs history).
   - **Inspect / manage tasks**: `job ls --json`, `job logs <id> --json`, `job stop <id> --json`.
3. **Pull artifacts**: `pull [--session N] <remotePath> <localPath> --json` fetches checkpoints, weights, or metrics back to the local workspace.

## 5. Hygiene

- Run `down [--session N | --all] --json` as soon as GPU work is finished so the runtime is unassigned (`DELETE /v1beta/runtimes/<id>`) and stops burning compute units.

## 6. Failure table

| Symptom / Exit code | Likely cause | Action |
|---|---|---|
| `up` exits `1` | Missing local prerequisite or config | Run `doctor --json` and resolve each item in `actions[]`. |
| `up` exits `2` (`step: "tailscale-peer"`) | Cell was not run, or Colab GPU quota is exhausted | Ask the user whether the cell is running or if Colab showed a GPU availability/quota dialog. |
| `up` exits `2` (`step: "ssh-banner"`) | `tailscaled` joined, but `sshd` has not finished starting | Re-run `status --json` or `up --json`. |
| `run` / `sync` / `pull` fails with connection refused or timeout | Colab runtime died or disconnected | Run `status --json`; if `reachable: false`, offer to run `down` + `up` and re-`sync`. |
| `down` exits `4` (`state: "zombie"`) | Kernel was busy or browser tab was closed so `runtime.unassign()` could not fire | Ask the user to open the Colab tab and select `Runtime → Disconnect and delete runtime`. |
