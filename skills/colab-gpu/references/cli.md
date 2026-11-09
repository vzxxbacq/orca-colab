# `orca-colab` CLI Reference

Invoke via `orca-colab <cmd> --json` or `npx -y github:vzxxbacq/orca-colab#v0.1.0 <cmd> --json`.
With `--json`, stdout carries exactly one JSON object and all progress/errors go to stderr with the `[colab]` prefix.

| Command | Description | Exit codes |
|---|---|---|
| `doctor [--json]` | Check Node ≥ 20, Tailscale binary & login state, `ssh`, `ssh-keygen`, `rsync` (optional), `git`, clipboard tool, `~/.orca-colab/config.json`, SSH keypair, and auth-key age. | `0` all required checks pass, `1` something missing (`actions[]`) |
| `setup [--auth-key K] [--login-server URL] [--notebook-url URL] [--account A] [--non-interactive] [--no-open] [--json]` | Save Tailscale auth key (`0600`), generate `~/.orca-colab/id_ed25519` if absent, print prefill values, and optionally open the bootstrap notebook. | `0` ok, `1` error |
| `auth [login \| status \| logout] [--account A] [--json]` | Sign in once via Google OAuth PKCE loopback in the system default browser (Passkey supported) to enable browserless Colab VS Code Direct API provisioning and CCU sync. | `0` ok, `1` error |
| `up [--name N] [--account A] [--gpu T4\|L4\|A100\|CPU] [--high-ram] [--browser] [--keep] [--timeout S=600] [--no-open] [--system-browser] [--json]` | Provision or connect to a Colab GPU runtime (headless via `v1beta/runtimes` + `/colab/tty` when OAuth is connected, or notebook fallback), wait for `orca-colab-*` peer, probe SSH on 22, query GPU via `nvidia-smi`, write session, and return session JSON with `estimatedCuPerHour`. | `0` ready, `1` prerequisite error, `2` timeout (`step`), `3` aborted |
| `status [--json]` / `ls [--json]` | List sessions with 3-second TCP port 22 reachability check (`reachable`) and `ageSeconds`. | `0` |
| `run [--session N] [--cwd DIR] [--env KEY=VAL] [--detach NAME \| --attach NAME] [--json] -- <cmd…>` | Execute `<cmd…>` on `root@ip` over SSH (`--cwd` defaults to session `remoteRoot`; allocates a PTY when stdin is a TTY). | Propagates remote exit code |
| `job submit [--session N] [--name TITLE] [--cwd DIR] [--env KEY=VAL] [--sync] [--wait] [--json] -- <cmd…>` | Submit an algorithm/compute task to the GPU session, stream live stdout/stderr to `~/.orca-colab/tasks/<id>.log`, and track status in `~/.orca-colab/tasks/<id>.json`. | `0` (or remote exit code with `--wait`) |
| `job ls [--session N] [--status S] [--json]` | List submitted GPU tasks with status (`running`, `succeeded`, `failed`, `stopped`), exit code, and session. | `0` |
| `job logs <id> [--tail N=200] [--follow] [--json]` | Read or follow live stdout/stderr output for task `<id>`. | `0` ok, `1` error |
| `job stop <id> [--json]` | Terminate a running task on the remote Colab GPU and mark it `stopped`. | `0` ok, `1` error |
| `sync [--session N] [--to DIR] [path=.] [--json]` | Push workspace to `/content/orca/<basename>` using `rsync` (honoring `.gitignore` and `.colabignore`, excluding `.git/`) or `tar \| ssh` fallback; updates `remoteRoot`. | `0` ok, `1` error |
| `pull [--session N] <remotePath> <localPath> [--json]` | Fetch `<remotePath>` from Colab into `<localPath>` via `rsync` or `ssh tar`. | `0` ok, `1` error |
| `forward [--session N] <port>[:<remotePort>] [--json]` / `forward --stop <port> [--json]` | Start or stop a background `ssh -N -L` local port forward; records PID in session file and outputs `http://localhost:<port>`. | `0` ok, `1` error |
| `down [--session N \| --all] [--json]` | Kill port forwards, call `DELETE /v1beta/runtimes/<id>` (when Direct API runtime) and touch `/root/.orca-colab/unassign` over SSH, wait ≤30 s for port 22 to close, record `session.end` in ledger, and delete session file (or mark `state: "zombie"` if still open). | `0` released (or already gone), `4` zombie |
| `credits [--account A] [--json]` | Show approximate balance (`estimatedBalanceCu`), burn rate (`estimatedBurnCuPerHour`), `estimatedHoursRemaining`, and monthly budget usage from the ledger. | `0` |
| `credits calibrate [--browser] [--account A] [--json]` | Sync balance from `colab.pa.googleapis.com/v1/user-info` (via OAuth) or Orca's browser (`--browser`). | `0` ok, `1` error |
| `credits set <cu> [--account A] [--json]` | Record a manual balance calibration event (`calibrate`) from Colab's Resources pane. | `0` ok, `1` error |
| `credits budget <cu> [--account A] [--json]` | Record a monthly compute-unit budget (`budget.set`) for the account. | `0` ok, `1` error |
| `ledger [--month YYYY-MM] [--account A] [--json]` | List raw credit ledger events (`session.start`, `session.end`, `calibrate`, `budget.set`). | `0` |
| `rates [--set KEY=CU_PER_HOUR] [--json]` | View or override approximate per-hour compute-unit rates (`T4`, `L4`, `A100`, `TPU v2-8`, `CPU`, `unknown`). | `0` ok, `1` error |
