---
name: colab-gpu
description: Set up and use a Google Colab GPU runtime as a remote compute backend over your Tailscale tailnet. Trigger when a task needs a GPU or CUDA, model training, fine-tuning, heavy inference that exceeds local laptop resources, or when the user mentions "Colab" or "run this on a GPU".
---

# Colab GPU Compute Backend (`colab-gpu`)

Use a disposable Google Colab GPU runtime over the user's Tailscale tailnet while keeping the workspace, coding agent, and credentials on the local machine. See [`references/cli.md`](references/cli.md) for the full command and exit-code table.

## 1. Resolve the CLI

Prefer `orca-colab` if installed on `PATH`; otherwise run:

```sh
npx -y github:vzxxbacq/orca-colab#v0.1.0 <command> --json
```

Always pass `--json` and parse **stdout** only (progress and diagnostics go to `stderr` prefixed with `[colab]`).

## 2. First run with the user

1. Run `doctor --json`.
2. For each failed check (`checks.<name>.ok === false`), give the user the single actionable step from `actions[]`.
3. When `checks.config.ok === false`, ask the user to create a **reusable, ephemeral, pre-approved** Tailscale auth key tagged `tag:orca-colab` in the Tailscale admin console. Explain its scope in one sentence: *this key only lets an ephemeral tagged Colab container join your tailnet, and the node disappears automatically when the Colab runtime ends.*
4. Run `orca-colab setup` in an interactive terminal the user can see (or ask them to run it) so they can paste the auth key, optionally save a prefilled copy of `notebooks/orca-colab-bootstrap.ipynb` in Google Drive, and paste the Drive copy's URL back.
5. Recommended: run `orca-colab auth login` once so the user can sign in with Google in their system default browser (Passkey supported). Once authenticated, `up`, `down`, and `credits calibrate` use the Colab VS Code Direct API with **zero browser tabs**.
6. Run `doctor --json` again and confirm `ok: true`.

## 3. Start a session

1. Check `credits --json` first. If `budgetCu` is set and `estimatedBudgetUsedPercent >= 100`, confirm with the user before starting a new session.
2. Prefer **T4** unless the task specifically requires L4 or A100 VRAM/throughput.
3. Run `up --gpu T4 --json`.
   - If the user has signed in with `orca-colab auth login`, `up` assigns the Colab runtime directly via `colaboratory.googleapis.com/v1beta/runtimes` and runs the Tailscale + `sshd` bootstrap over `/colab/tty` with **no browser needed**.
   - Otherwise (notebook fallback), tell the user:
     > "A Colab tab opened. Choose a GPU runtime (`Runtime → Change runtime type`) if needed and press **Run** on the cell."
4. Do not poll faster than the CLI does; `up --json` blocks until the new `orca-colab-*` peer joins, `sshd` responds on port 22, and `nvidia-smi` reports the GPU.
5. Before launching long jobs, state the approximate burn rate (`estimatedCuPerHour` from `up --json`) and estimated hours of balance remaining (`estimatedHoursRemaining` from `credits --json`), explicitly noting that credit figures are **estimates**.

## 4. Do the work

1. **Sync workspace**: `sync --json` pushes the current directory (honoring `.gitignore` and `.colabignore`, excluding `.git/`) to `/content/orca/<basename>` and records `remoteRoot`.
2. **Install dependencies**: `run -- pip install -r requirements.txt`.
3. **Run training or inference (`job` or `run`)**:
   - **Managed tasks (recommended for training/benchmarks)**: `job submit --name "Train Model" [--sync] [--wait] --json -- python3 train.py ...` records the task in `~/.orca-colab/tasks/<id>.json` and streams live output to `~/.orca-colab/tasks/<id>.log` (visible in the Orca Colab GPU panel's **Current Task Output** console). Check status with `job ls --json`, read logs with `job logs <id> --json`, or stop with `job stop <id> --json`.
   - **Direct SSH commands**: `run -- python3 train.py ...` or `run --detach train -- python3 train.py ...`.
4. **Pull artifacts**: `pull <remotePath> <localPath> --json` to fetch checkpoints, metrics, or outputs back to the local workspace.
5. **Port forwarding**: `forward <localPort>[:<remotePort>] --json` for TensorBoard (`6006`), Jupyter (`8888`), Gradio (`7860`), or vLLM (`8000`), then give the user the `http://localhost:<localPort>` URL.

## 5. Hygiene

- Colab runtimes are ephemeral (≈90 min idle timeout / 12 h cap on free tier; longer on Pro). Tell the user to **keep the Colab browser tab open**.
- Write checkpoints frequently to the synced directory and `pull` results as soon as they exist.
- Never store persistent credentials on Colab. Pass runtime API keys with `run --env KEY=VALUE` only when the user explicitly agrees.
- Run `down --json` as soon as GPU work is finished so the runtime is unassigned and stops burning compute units. If `down` exits with code `4` (`state: "zombie"`), instruct the user to click `Runtime → Disconnect and delete runtime` in Colab.

## 6. Failure table

| Symptom / Exit code | Likely cause | Action |
|---|---|---|
| `up` exits `1` | Missing local prerequisite or config | Run `doctor --json` and resolve each item in `actions[]`. |
| `up` exits `2` (`step: "tailscale-peer"`) | Cell was not run, or Colab GPU quota is exhausted | Ask the user whether the cell is running or if Colab showed a GPU availability/quota dialog. |
| `up` exits `2` (`step: "ssh-banner"`) | `tailscaled` joined, but `sshd` has not finished starting | Re-run `status --json` or `up --json`. |
| `run` / `sync` / `pull` fails with connection refused or timeout | Colab runtime died or disconnected | Run `status --json`; if `reachable: false`, offer to run `down` + `up` and re-`sync`. |
| `down` exits `4` (`state: "zombie"`) | Kernel was busy or browser tab was closed so `runtime.unassign()` could not fire | Ask the user to open the Colab tab and select `Runtime → Disconnect and delete runtime`. |
