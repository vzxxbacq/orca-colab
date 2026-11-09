# `orca-colab` CLI Reference

Invoke via `orca-colab <cmd> --json` or `npx -y github:vzxxbacq/orca-colab#v0.1.0 <cmd> --json`.
With `--json`, stdout carries exactly one JSON object and all progress/errors go to stderr with the `[colab]` prefix.

| Command | Description | Exit codes |
|---|---|---|
| `doctor [--json]` | Check Node ≥ 20, Tailscale binary & login state, `ssh`, `ssh-keygen`, `rsync` (optional), `git`, clipboard tool, `~/.orca-colab/config.json`, SSH keypair, and auth-key age. | `0` all required checks pass, `1` something missing (`actions[]`) |
| `setup [--auth-key K] [--login-server URL] [--notebook-url URL] [--account A] [--non-interactive] [--no-open] [--json]` | Save Tailscale auth key (`0600`), generate `~/.orca-colab/id_ed25519` if absent, print prefill values, and optionally open the bootstrap notebook. | `0` ok, `1` error |
| `up [--name N] [--account A] [--keep] [--timeout S=600] [--no-open] [--system-browser] [--json]` | Snapshot peers, open the notebook (copying `<authkey> <pubkey>` to clipboard on fallback path), wait for new `orca-colab-*` peer, probe SSH on 22, query GPU via `nvidia-smi`, write session, and return session JSON with `estimatedCuPerHour`. | `0` ready, `1` prerequisite error, `2` timeout (`step`), `3` aborted |
| `status [--json]` / `ls [--json]` | List sessions with 3-second TCP port 22 reachability check (`reachable`) and `ageSeconds`. | `0` |
| `run [--session N] [--cwd DIR] [--env KEY=VAL] [--detach NAME \| --attach NAME] [--json] -- <cmd…>` | Execute `<cmd…>` on `root@ip` over SSH (`--cwd` defaults to session `remoteRoot`; allocates a PTY when stdin is a TTY). | Propagates remote exit code |
| `sync [--session N] [--to DIR] [path=.] [--json]` | Push workspace to `/content/orca/<basename>` using `rsync` (honoring `.gitignore` and `.colabignore`, excluding `.git/`) or `tar \| ssh` fallback; updates `remoteRoot`. | `0` ok, `1` error |
| `pull [--session N] <remotePath> <localPath> [--json]` | Fetch `<remotePath>` from Colab into `<localPath>` via `rsync` or `ssh tar`. | `0` ok, `1` error |
| `forward [--session N] <port>[:<remotePort>] [--json]` / `forward --stop <port> [--json]` | Start or stop a background `ssh -N -L` local port forward; records PID in session file and outputs `http://localhost:<port>`. | `0` ok, `1` error |
| `down [--session N \| --all] [--json]` | Kill port forwards, touch `/root/.orca-colab/unassign` over SSH, wait ≤30 s for port 22 to close, record `session.end` in ledger, and delete session file (or mark `state: "zombie"` if still open). | `0` released (or already gone), `4` zombie |
| `credits [--account A] [--json]` | Show approximate balance (`estimatedBalanceCu`), burn rate (`estimatedBurnCuPerHour`), `estimatedHoursRemaining`, and monthly budget usage from the ledger. | `0` |
| `credits set <cu> [--account A] [--json]` | Record a manual balance calibration event (`calibrate`) from Colab's Resources pane. | `0` ok, `1` error |
| `credits budget <cu> [--account A] [--json]` | Record a monthly compute-unit budget (`budget.set`) for the account. | `0` ok, `1` error |
| `ledger [--month YYYY-MM] [--account A] [--json]` | List raw credit ledger events (`session.start`, `session.end`, `calibrate`, `budget.set`). | `0` |
| `rates [--set KEY=CU_PER_HOUR] [--json]` | View or override approximate per-hour compute-unit rates (`T4`, `L4`, `A100`, `TPU v2-8`, `CPU`, `unknown`). | `0` ok, `1` error |
