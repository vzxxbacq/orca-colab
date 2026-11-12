# Design

## Goal

Let a coding agent running **locally** in Orca (Claude Code, Codex, …) set up a Google Colab GPU
runtime together with the user in a few minutes, then use that GPU as a compute backend: sync code to
it, run training or inference there, forward ports, pull results back. The workspace, the agent and the
user's credentials stay on the local machine. Colab is a disposable GPU box reached over the user's
tailnet.

Three deliverables, one repo:

| Deliverable | Who uses it | What it is |
|---|---|---|
| `skills/colab-gpu/SKILL.md` | the agent | Procedure: when to reach for Colab, how to run the one-time setup with the user, the per-session flow, how to run work and fetch results, hygiene. Installed with `npx skills add vzxxbacq/orca-colab`. |
| `bin/orca-colab.mjs` (+ `bin/lib/`) | the agent (via the skill) and the user | Zero-dependency Node CLI. `doctor`, `setup`, `up`, `status`, `run`, `sync`, `pull`, `forward`, `down`. Every command has `--json`. Run as `npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/<release-sha> <cmd>` or `npm i -g`. |
| Orca plugin (`orca-plugin.json`, `worker/`, `panel/`) | the user, in Orca's UI | Panel showing sessions, GPU, age and prerequisites; a "Start Colab session" command that opens an Orca terminal running `orca-colab up`; status bar item with the live session count. |
| `notebooks/orca-colab-bootstrap.ipynb` | runs inside Colab | Joins the tailnet, starts `sshd`, reports the GPU. |

## Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **Agents run locally; Colab is a compute backend reached over SSH**, not an Orca remote host. | The owner's call. Keeps credentials, repo and agent sessions on the laptop; Colab VMs are too short-lived to host agent state. The earlier VM-recipe design is kept as an optional later mode (see "Optional remote-workspace mode"). |
| D2 | **Tailscale with a plain `sshd` inside Colab** (not Tailscale SSH, not a public tunnel). | Colab allows no inbound traffic; Tailscale userspace mode forwards inbound tailnet traffic to local ports. Tailscale SSH's default ACL is `check` mode, which breaks non-interactive clients. Self-hosted DERP works unchanged (the DERP map comes from the control plane); Headscale works through a `loginServer` setting. |
| D3 | **Pre-authorised, reusable, ephemeral, tagged auth key** (`tag:orca-colab`) joins Colab to the tailnet. The user creates it once in the admin console; `setup` stores it in `~/.orca-colab/config.json` (0600). | No per-session Tailscale login click. Ephemeral devices vanish when the VM dies, so no device accumulation. The key's only power is to add a tagged node; ACLs can confine such nodes to inbound SSH from the user's own devices. 90-day max expiry; `doctor` warns 7 days ahead. |
| D4 | **One SSH key pair for all sessions**, `~/.orca-colab/id_ed25519`, created by `setup`. | Lets the public key be prefilled once (D5). Per-session keys bought nothing once auth keys replaced pasting. |
| D5 | **Two notebook paths.** Default: the user saves a personal copy of the bootstrap notebook in Drive with the auth key, login server and public key prefilled in the form cell; `setup` prints the exact values and stores the copy's URL as `accounts[0].notebookUrl` (label `default`; M2 adds more accounts, not a new shape). Fallback: open the GitHub-hosted notebook and paste one line `<authkey> <pubkey>` from the clipboard. | Default path makes a session "Colab tab opens → click Run". Fallback needs no Drive and still has zero logins. |
| D6 | **Session discovery = a new online tailnet peer with hostname prefix `orca-colab-`** that was not present when `up` started; the notebook generates the suffix. | No id has to travel from laptop to Colab. `up --name x` pins the hostname for the fallback path. |
| D7 | **File transfer = `rsync` over SSH when available, else `tar | ssh`**; `sync` pushes the workspace (honouring `.gitignore` and `.colabignore`), `pull` fetches a remote path. No Git credentials go to Colab. | Works for private repos and uncommitted work, which is what an agent mid-task has. |
| D8 | **Port forwarding is plain `ssh -L`** managed by the CLI (`forward <port>` records the pid; `down` kills it). | Jupyter, TensorBoard, Gradio, vLLM on Colab show up at `localhost:<port>` for the user and the agent. |
| D9 | **Dual provisioning modes: Colab Direct API (default once authenticated) + Notebook fallback.** `orca-colab auth login` runs an OAuth 2.0 PKCE loopback flow (`127.0.0.1:<port>`, scopes `profile email https://www.googleapis.com/auth/colaboratory`, all non-sensitive) with Orca Colab Community's own Desktop OAuth client, never another product's client or headers, in the user's system browser (where Passkeys work natively), saving the refresh token in `~/.orca-colab/google-oauth.json` (`0600`). Once signed in, `up`, `down`, and `credits calibrate` talk directly to `colaboratory.googleapis.com` (`v1beta/runtimes`) and `colab.research.google.com/tun/m/ccu-info` (balance; `colab.pa.googleapis.com/v1/user-info` rejects third-party clients) plus `wss://<runtime>/colab/tty` with **zero browser tabs**. The notebook flow (`--browser`) remains available as a zero-OAuth fallback. | Users with Passkey-protected Google accounts only sign in once in their default browser; every subsequent `up`, `down`, and CCU check is 100 % headless and deterministic. |
| D10 | **`down` releases the runtime via Direct API (`DELETE /v1beta/runtimes/<id>?allowMissing=true`) and/or the in-kernel watcher**: when a session has `colabRuntime.id`, `down` calls `deleteRuntime` directly; for browser-provisioned sessions, the bootstrap notebook starts a daemon thread inside the kernel that polls for `/root/.orca-colab/unassign`; `down` touches that file over SSH, waits up to 30 s for the SSH port to disappear, and only then reports `released: true`; otherwise `released: false, reason` and the session is kept with state `zombie` so the user is told to stop it in Colab's UI. No suspend/resume: a dead runtime is a dead runtime. | Calling `DELETE /v1beta/runtimes/<id>` works without any browser tab open; the `/root/.orca-colab/unassign` sentinel covers the notebook fallback path. |
| D11 | **The Orca plugin is thin on provisioning, thick on stewardship and task management.** It reads `~/.orca-colab/`, manages GPU tasks and streams live task output, refreshes Colab runtime tokens, and owns the always-on parts: task execution monitor, live output streaming, credit ledger, idle watchdog, budget alerts. | Watching sessions, tasks, live task logs, and credits needs a process that outlives any one CLI call; the worker is kept alive by its status bar item. |
| D12 | **Credits combine live API calibration (`/tun/m/ccu-info`) with a local ledger.** Each session records GPU type, start, end and a per-hour rate from an editable rate table; `credits calibrate` fetches the real CCU balance and hourly burn rate via `colab.research.google.com/tun/m/ccu-info?authuser=0` (or via Orca's browser / manual entry), and the ledger counts down between calibrations. | Even with API calibration, projecting between checks and enforcing monthly budgets requires an append-only local ledger; projected numbers always carry the `estimated` prefix in `--json` and show calibration age. |
| D13 | **Calibration supports Direct API (`credits calibrate`), Orca's embedded browser (`credits calibrate --browser`), and manual entry (`credits set <cu>`).** Every failure degrades cleanly to manual entry. | Gives instant one-click CCU sync when OAuth is connected while preserving the browser and manual fallbacks. |
| D14 | **Idle watchdog in the worker, two independent signals, both required.** (1) No CLI or task activity: every CLI command and running job stamps `lastActivityAt` at start, every 60 s while it runs, and at exit, and records its pid in `activePids`; a session with a live pid or running task is never idle. (2) GPU utilisation under 5 % on **three consecutive** 5-minute samples. Only when both hold for `autoStopIdleMinutes` (default 20) does the worker notify, then run `down` after a 5-minute grace unless the user cancels. `up --keep` exempts a session. | Forgotten runtimes are where Colab credits go, but a 40-minute `run` or `job` that is downloading a dataset or writing a checkpoint must never be killed by one low GPU sample. |
| D15 | **Several Google accounts = several credit pools.** `config.json` holds the static part, `accounts: [{ label, notebookUrl }]` and `defaultAccount`; OAuth tokens live in `google-oauth.json` (`0600`) keyed by account label; every money fact (calibrations, budgets, session costs) lives only in `ledger.jsonl`, keyed by account label. `up --account` picks one; the panel shows each pool. | Users with Pro on one account and pay-as-you-go on another need to choose where a session's cost lands. |
| D16 | **Browser fallback & security boundaries.** When OAuth is used (`auth login`), one PKCE loopback login in the system browser is all that is ever needed; no browser is opened during `up`. When the notebook fallback (`up --browser`) is used inside an Orca terminal (`ORCA_WORKTREE_ID || ORCA_WORKSPACE_ID || ORCA_PANE_KEY`), it can open in Orca's browser or the system browser. The plugin never reads or exports browser cookie databases. | Keeps authentication clean, Passkey-compatible, and free of browser-cookie scraping. |
| D17 | **First-class Task Management (`job` CLI + Plugin Task Manager & Live Output Console).** Submitted algorithm/compute tasks (`orca-colab job submit`) are persisted in `~/.orca-colab/tasks/<id>.json` with real-time stdout/stderr streamed to `~/.orca-colab/tasks/<id>.log`. Commands can optionally sync the workspace first (`--sync`), run detached in the background (default) or foreground (`--wait`), be stopped (`job stop <id>`), and have their live output streamed in the Orca plugin panel. | Treating Colab as an algorithm compute backend requires queuing/running training jobs, monitoring their live stdout/stderr in the panel without keeping an interactive SSH shell open, and inspecting exit codes and durations after completion. |
| D18 | **Remote Orca servers: the panel follows the workspace, through its terminal.** Orca runs plugin workers in the desktop client, but a remote workspace's terminals, agents and `~/.orca-colab` live on the server. When the focused workspace has a `hostId`, the worker opens one background terminal there (`Colab Bridge`) running `orca-colab watch` and talks to it with `terminal.send` / `terminal.read`; state arrives as gzip+base64 frames, actions are typed in as `call <id> <action> <base64 json>` lines, and the same `bin/lib/panel-actions.mjs` runs on either side. Google sign-in runs on the desktop (its own browser, its own loopback) with `persist: false`; the tokens are sealed to the X25519 key the server's `watch` publishes in every snapshot (`origin.sealKey`, AES-256-GCM via `bin/lib/credential-envelope.mjs`) and imported there with `authImport`, so the terminal scrollback only ever carries ciphertext and the client keeps nothing. `auth login --no-browser` + `auth redirect <url>` remain for headless CLI use and for a `watch` too old to publish a key. Local workspaces keep the direct `fs` path. | Reuses the connection the user already has to the server, so no SSH, no daemon, no extra token and no new network path. The price is a visible terminal per remote workspace, a 2000-line read window (frames are self-contained, so lost ones are harmless), roughly 1.5 s latency, and no bridge from browser clients, which run no plugin worker at all. |

## The user's experience

One-time (about 5 minutes, agent-guided):

1. Agent runs `orca-colab doctor`; tells the user what is missing (Tailscale signed in, Node ≥ 20, rsync).
2. Agent asks the user to create a Tailscale auth key (reusable, ephemeral, pre-approved, tag
   `orca-colab`) and paste it into the terminal when `orca-colab setup` prompts. `setup` writes config and
   the SSH key pair, prints the three values to prefill, and offers to open the notebook so the user can
   "Save a copy in Drive", fill the form once, and paste the copy's URL back.

Per session (about 2 minutes, mostly waiting on Colab):

1. Agent runs `orca-colab up --json` (or the user presses "Start Colab session" in the Orca panel).
   The notebook copy opens in Orca's embedded browser (system browser outside Orca).
2. User picks a GPU runtime if not already set, presses Run. Tailscale auth and `sshd` take ~60 s.
3. `up` sees the peer, probes SSH, runs `nvidia-smi --query-gpu=name,memory.total --format=csv`, prints
   the session JSON and exits. Agent continues on its own: `sync`, `run`, `pull`, `forward`.

## Credit management

What the user sees in the panel, per account:

```
Account: work (Pro)              balance ≈ 61.3 CU   calibrated 2 days ago   [Calibrate]
Burn now: 1.96 CU/h (T4)        at this rate ≈ 31 h left     budget: 80 CU/month, used 18.7
Sessions this month: 7          wasted idle (auto-stopped): 2.4 CU
```

Mechanics:

- **Rate table** `~/.orca-colab/rates.json`, user-editable, shipped defaults (compute units per hour,
  approximate, Nov 2026): `T4 1.96`, `L4 4.82`, `A100 11.77`, `TPU v2-8 1.76`, `CPU 0.08`, `unknown 2`.
  `nvidia-smi` names map to keys (`Tesla T4` → `T4`, `NVIDIA A100-SXM4-40GB` → `A100`). High-RAM adds a
  multiplier (default 1.0 until measured; recorded per session when the notebook reports total RAM).
- **Ledger** `~/.orca-colab/ledger.jsonl`, one line per event: `session.start`, `session.end` (with cause
  `user|idle-watchdog|colab-died`), `calibrate` (balance, source `manual|browser`), `budget.set`.
  Estimated balance = last calibration − Σ(hours × rate) since. Free-tier accounts have no balance; the
  ledger still records hours so the user can see usage against the unofficial quota.
- **Budget**: optional, set per account with `credits budget <cu>` (a `budget.set` ledger event; the latest one wins); the status bar turns `warning` at 80 %, `danger` at 100 %; the
  skill tells the agent to confirm with the user before `up` once the budget is exceeded.
- **Pre-flight estimate**: `up --json` returns `estimatedCuPerHour`; the skill makes the agent state
  "about N CU/h, ~H hours of balance left" before long jobs and prefer T4 unless the task needs more.
- **Calibration sources**: `credits set <balance> [--account]` (manual, from Colab's Resources pane);
  M2 `credits calibrate --browser` opens colab.research.google.com with `orca tab create --url`, calls the
  Resources pane's internal endpoint from page context with `orca eval --expression --page <browserPageId
  from tab create --json> --expect-url …` (same origin, user cookies), parses the JSON, and only then falls back to the pane text; the panel's Calibrate button runs the same. The user signs in
  to Google inside Orca's browser once; nothing is stored by this plugin.
- **Idle watchdog** (D14): the CLI stamps `lastActivityAt` in the session file on every command; the
  worker samples `nvidia-smi --query-gpu=utilization.gpu` over SSH every 5 min; both idle → notify → `down`.

CLI additions: `credits [--json]` (balances, burn, projection), `credits set <cu> [--account A]`,
`credits budget <cu>`, `credits calibrate --browser` (M2), `ledger [--month YYYY-MM] [--json]`,
`rates [--set T4=2.0]`, `up --keep` (no auto-stop), `up --account A`.

## CLI (`bin/orca-colab.mjs`)

Plain Node ≥ 20, zero dependencies, `package.json` with `"bin"`. State:

```
~/.orca-colab/config.json        static settings, 0600: { authKey, authKeyCreatedAt, loginServer?, tags,
                                   remoteRootBase, accounts: [{ label, notebookUrl? }], defaultAccount }
                                   Never balances or budgets: those are ledger events (single source of truth).
~/.orca-colab/google-oauth.json  per-account OAuth 2.0 tokens, 0600: { accounts: { [label]: { refreshToken,
                                   accessToken, expiryDate, email? } } }. Never logged or emitted in --json.
~/.orca-colab/id_ed25519(.pub)   global key pair, comment "orca-colab"
~/.orca-colab/known_hosts        per-IP host keys; hosts are disposable, StrictHostKeyChecking=accept-new
~/.orca-colab/sessions/<name>.json  { name, account, hostname, ip, gpu, rateKey, cuPerHour, createdAt,
                                      lastActivityAt, activePids, keep, state: active|zombie,
                                      remoteRoot, forwards: [{port, pid}],
                                      colabRuntime?: { id, endpoint, baseUrl, token, tokenExpiry } }
~/.orca-colab/tasks/<id>.json    { id, name, command, sessionName, account, cwd, status:
                                   running|succeeded|failed|stopped, exitCode, createdAt, startedAt,
                                   finishedAt, localPid, remotePid?, logPath }
~/.orca-colab/tasks/<id>.log     combined stdout/stderr stream for task <id>
~/.orca-colab/ledger.jsonl       append-only credit events (see Credit management)
~/.orca-colab/rates.json         editable CU/h table
```

| Command | Does | Exit |
|---|---|---|
| `doctor [--json]` | Finds `tailscale` (PATH, macOS app bundle, Windows path), parses `tailscale status --json` (`BackendState`, `Self`), checks `ssh`, `ssh-keygen`, `rsync` (optional), `git`, clipboard tool, config presence, auth-key age, OAuth login state. | 0 all good, 1 something missing (each line actionable) |
| `setup [--auth-key K] [--login-server URL] [--notebook-url URL] [--non-interactive]` | Writes config, generates the key pair if absent, prints prefill values, optionally opens the notebook. Prompts on a TTY for anything not passed. | 0 / 1 |
| `auth [login\|status\|logout] [--account A] [--json]` | Loopback PKCE OAuth 2.0 login in system default browser with the project's own OAuth client (supports Passkey), shows connected Google account & Colab tier/balance, or revokes/removes stored credentials. | 0 / 1 |
| `up [--name N] [--account A] [--gpu T4\|L4\|A100\|CPU] [--high-ram] [--browser] [--keep] [--timeout S=600] [--no-open] [--system-browser] [--json]` | When OAuth is connected (and `--browser` not set): assigns runtime directly via `POST /v1beta/runtimes`, runs the Tailscale + `sshd` bootstrap over `wss://<runtime>/colab/tty` with zero browser tabs, waits for the Tailscale peer & SSH banner, queries GPU, writes session. Otherwise uses the notebook flow. | 0, 1 prerequisite, 2 timeout (says which step), 3 aborted |
| `status [--json]` / `ls` | Lists sessions, re-checking reachability (3 s TCP probe), live RAM/Disk/GPU resources (when `colabRuntime` present), and age. | 0 |
| `run [--session N] [--cwd DIR] -- <cmd…>` | `ssh root@ip` with a pty when stdin is a TTY, streams output, propagates the exit code. `--cwd` defaults to the session's `remoteRoot`. | remote exit code |
| `job submit [--session N] [--name TITLE] [--cwd DIR] [--env K=V] [--sync [PATH]] [--wait] [--json] -- <cmd…>` | Submits an algorithm/compute task to the GPU session, streams stdout/stderr to `~/.orca-colab/tasks/<id>.log`, and tracks status (`running`, `succeeded`, `failed`, `stopped`) in `~/.orca-colab/tasks/<id>.json`. Runs detached by default (`--wait` blocks and streams). | 0 (or remote exit code with `--wait`) |
| `job ls [--session N] [--status S] [--json]` | Lists submitted tasks with status, duration, exit code, session, and command. | 0 |
| `job logs <id> [--tail N=100] [--follow] [--json]` | Reads or follows the live stdout/stderr log for task `<id>`. | 0 / 1 |
| `job stop <id> [--json]` | Terminates a running task (kills remote process group and local runner) and marks it `stopped`. | 0 / 1 |
| `sync [--session N] [--to DIR] [path=.]` | rsync `-az --delete --filter=':- .gitignore' --filter=':- .colabignore'` to `/content/orca/<basename>`; `tar | ssh` fallback. Records `remoteRoot`. | 0 / 1 |
| `pull [--session N] <remotePath> <localPath>` | rsync or `ssh tar` back. | 0 / 1 |
| `forward [--session N] <port>[:<remotePort>]` / `forward --stop <port>` | Background `ssh -N -L`, pid recorded in the session file; prints `http://localhost:<port>`. | 0 / 1 |
| `down [--session N\|--all] [--json]` | Kills forwards, calls `DELETE /v1beta/runtimes/<id>?allowMissing=true` when `colabRuntime.id` is present (and/or touches `/root/.orca-colab/unassign` over SSH per D10), waits ≤30 s for port 22 to close, writes `session.end` to the ledger, deletes the session file when released or marks it `zombie` and says what to do. | 0 released, 4 zombie |
| `credits [--account A] [--json]` | Estimated balance, burn rate, projection, budget use per account, from the ledger. | 0 |
| `credits set <cu> [--account A]` / `credits budget <cu> [--account A]` / `credits calibrate [--browser] [--account A]` | Append `calibrate` / `budget.set` events. `calibrate` queries `/tun/m/ccu-info` via OAuth API first, or Orca's browser with `--browser`. | 0 / 1 |
| `ledger [--month YYYY-MM] [--json]` | Session and calibration history. | 0 |
| `rates [--set KEY=CU_PER_HOUR]` | Show or override the rate table. | 0 |

Every CLI command stamps `lastActivityAt` (start, every 60 s, exit) and its pid for the watchdog (D14).
Every SSH invocation uses `-i ~/.orca-colab/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes
-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=~/.orca-colab/known_hosts -o ConnectTimeout=10`.
Default session = the only one, or the newest; `--session` otherwise. `--json` output is one object on
stdout; everything else on stderr, so agents can parse safely.

## Skill (`skills/colab-gpu/SKILL.md`)

Frontmatter `name: colab-gpu`, `description` that triggers on: GPU, CUDA, training, fine-tuning, model
inference too heavy for the laptop, "Colab", "run this on a GPU". Body sections:

1. **Resolve the CLI**: prefer `orca-colab` on PATH, else `npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/<release-sha>`.
   Always pass `--json` and read stdout only.
2. **First run with the user**: run `doctor`; for each failure give the user the one action; run `setup`
   in an Orca terminal the user can see (`orca terminal` from the orca-cli skill, or ask them). Explain
   the auth key's scope in one sentence. Confirm with `doctor` again.
3. **Start a session**: `up --json`; while waiting, tell the user exactly: "A Colab tab opened. Choose a
   GPU runtime (Runtime → Change runtime type) if needed and press Run on the cell." Do not poll faster
   than the CLI does; it blocks until done.
4. **Do the work**: `sync` the workspace, `run -- pip install -r requirements.txt`, `run -- python
   train.py …` with `nohup`/`tmux` for long jobs and `run -- tail -f` to follow; `pull` results into the
   workspace; `forward` for TensorBoard/Jupyter/Gradio and give the user the localhost URL.
5. **Hygiene**: Colab sessions die (≈90 min idle on free tier, 12 h cap; longer on Pro). Pull results as
   soon as they exist; write checkpoints to the synced dir and pull them; tell the user to keep the tab
   open; run `down` when finished. Never store secrets on Colab beyond the session; pass API keys as
   `run --env` only when the user agrees.
6. **Failure table**: `up` exit 2 → ask whether the cell was run / GPU quota exhausted; `run` connection
   refused → `status`, likely the runtime died, offer `up` again and re-`sync`.

Distribution: `npx skills add vzxxbacq/orca-colab` (agentskills layout); the README shows the command.
The Orca plugin's panel also shows it for copy-paste. `contributes.skills` in Orca manifests is still
reserved, so the plugin cannot install the skill itself yet.

## Bootstrap notebook (`notebooks/orca-colab-bootstrap.ipynb`)

Markdown cell: what this does, "pick a GPU runtime first", the one-line security note. Form cell:

```python
#@title Connect this runtime to your tailnet for orca-colab
TAILSCALE_AUTH_KEY = ""     #@param {type:"string"}
SSH_PUBLIC_KEY = ""         #@param {type:"string"}
TAILSCALE_LOGIN_SERVER = "" #@param {type:"string"}
HOSTNAME_SUFFIX = ""        #@param {type:"string"}
PASTE = ""                  #@param {type:"string"}   # fallback: "<authkey> <pubkey>" in one line
```

Code cell, as root:

1. Resolve values (`PASTE` overrides the two fields); fail loudly if the key does not start with
   `ssh-ed25519`/`ssh-rsa` or the auth key does not start with `tskey-`.
2. `apt-get install -y -qq openssh-server rsync`; `authorized_keys` 0600; `PermitRootLogin
   prohibit-password`, `PasswordAuthentication no`; start `sshd`.
3. Install Tailscale; `tailscaled --tun=userspace-networking --socks5-server=localhost:1055
   --state=/root/tailscaled.state &`; `tailscale up --authkey … --hostname orca-colab-<suffix or 6 random
   chars> --accept-dns=false --accept-routes=false [--login-server …]`.
4. Start a daemon thread **inside the kernel** that polls `/root/.orca-colab/unassign` every 5 s and calls
   `google.colab.runtime.unassign()` when it appears (D10). Also writes `/root/.orca-colab/ready`.
5. Print `nvidia-smi -L` (or the "no GPU" hint), `tailscale ip -4`, and "Connected. Keep this tab open."
6. Separate, not-auto-run cell: a keepalive loop that touches a file every 5 min (does not defeat the
   browser idle rule; documented as such).

No outputs committed. No pip packages.

## Orca plugin

```json
{
  "$schema": "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "colab",
  "name": "Orca Colab Community",
  "version": "0.1.0",
  "description": "Community plugin: use a Google Colab GPU runtime as a compute backend from your local Orca workspace and agents. Unofficial; not affiliated with or endorsed by Google.",
  "repository": "https://github.com/vzxxbacq/orca-colab",
  "license": "MIT",
  "engines": { "orca": ">=1.4.248" },
  "pluginApi": 1,
  "main": "worker/main.mjs",
  "contributes": {
    "panels": [{ "id": "colab", "title": "Colab GPU", "icon": "zap", "entry": "panel/index.html" }],
    "commands": [
      { "id": "colab.up", "title": "Colab: Start GPU session", "when": "workspace" },
      { "id": "colab.down", "title": "Colab: Stop GPU session" },
      { "id": "colab.showPanel", "title": "Colab: Show sessions" }
    ],
    "statusBarItems": [{ "id": "colab-sessions", "icon": "zap", "text": "Colab", "command": "colab.showPanel" }],
    "settings": [
      { "key": "autoStopIdleMinutes", "title": "Auto-stop idle sessions after (minutes)", "type": "integer", "default": 20, "minimum": 0 },
      { "key": "cliCommand", "title": "orca-colab command", "type": "string", "default": "npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/85b32e00d93b5d598ac0bd470363bfd3ac76c12b" }
    ]
  },
  "capabilities": [
    { "kind": "workspace:read" },
    { "kind": "terminal:send" },
    { "kind": "notifications:show" },
    { "kind": "storage:own" },
    { "kind": "settings:own" }
  ]
}
```

- Worker: reads `~/.orca-colab/sessions/*.json`, `~/.orca-colab/tasks/*.json`, and the ledger (poll + `fs.watch`), streams active task log updates (`~/.orca-colab/tasks/<id>.log`) to the panel via `orca.panels.post("colab.taskOutput", ...)`, refreshes `colabRuntime` proxy tokens before expiry, updates the status bar (`Colab: T4 · 1 running · 1.96 CU/h · ≈61 CU`, hidden with no sessions and no balance; tone follows the budget), runs the idle watchdog (D14) and the budget alerts. `colab.up` → resolve the focused workspace's id by matching `workspace.readContext` against `workspace.list` (readContext has no id), then `terminal.create({ workspaceId, title: "Colab", command: "<cliCommand> up" })` (or provisions headlessly via `colab.startSession`); `colab.down` likewise with `down`. `colab.showPanel` spawns `orca plugin open vzxxbacq.colab --panel colab` (no host method opens a panel). Panel handlers: `colab.dashboard` (`colab.sessions` + `colab.doctor` + `colab.tasks` + `colab.credits`), `colab.authLogin`, `colab.startSession`, `colab.stopSession`, `colab.toggleKeep`, `colab.submitTask`, `colab.stopTask`, `colab.getTaskLogs`, `colab.calibrateCredits`, `colab.setCredits`, `colab.setBudget`, `colab.openTerminal`.
- Panel:
  1. **Header & Account / Auth Bar**: Google OAuth status badge (`Sign in with Google` or connected account + tier), prerequisite indicators (`Tailscale`, `SSH Key`, `Auth Key`, `Google OAuth`), and quick refresh.
  2. **GPU Runtime & Resource Monitor**: Accelerator selector (`T4`, `L4`, `A100`, `CPU`), 1-click browserless **Start GPU** / **Open Terminal**, active session cards showing GPU model, VRAM, live RAM/Disk/GPU utilization bars, tailnet IP, uptime, burn rate, and **Keep** / **Stop** controls.
  3. **Task Manager & Job Queue**:
     - **Submit Task Form**: Task title, command input (e.g. `python3 train.py --epochs 20`), optional `Sync workspace first` checkbox, and **Submit Task** button.
     - **Task List**: Displays all submitted tasks (`RUNNING`, `SUCCEEDED`, `FAILED`, `STOPPED`) with live elapsed timer, exit code, session badge, command preview, and action buttons (**Output**, **Stop**, **Run in Terminal**).
  4. **Current Task Live Output Console**:
     - Real-time terminal log viewer for the active or selected task (`~/.orca-colab/tasks/<id>.log`), with status badge, auto-scroll (`Follow`) toggle, **Copy Output**, and **Refresh**.
  5. **Credits & Budget Stewardship**: Estimated balance, live burn rate, remaining hours projection, **Sync CCU** (Direct API / Browser), manual balance & monthly budget controls, and skill install snippet.
  Inline assets only; Orca frame CSS variables.
  6. **Origin badge**: `Local` or `Server · <workspace>` in the top bar, so the user always knows whose
     `~/.orca-colab` is on screen; a paste box for the redirect URL appears during a remote sign-in.
- Remote workspaces (D18): `worker/main.mjs` holds one `LocalBridge` plus one `TerminalBridge` per remote
  workspace and switches between them as the focused workspace changes. A workspace is remote when its
  `workspace.list` row has a `hostId` other than `local`, or when `readContext` names a workspace that
  `workspace.list` does not contain at all (what the desktop client reports for server-hosted projects).
  Finding or starting the bridge terminal, in order: a terminal from `readContext.terminals` that already
  prints frames; `terminal.create` when the host API has the workspace id; otherwise the local `orca` CLI
  (`bin/lib/orca-remote-helper.mjs`: `worktree show --worktree active`, `terminal list/create/read/send`)
  through the same client↔server connection, switching the bridge to the CLI transport when the host API
  does not know the handle; only when all of that fails does the panel show the exact command to run by
  hand. The bridge terminal runs `<remoteCliCommand> watch --auto-stop-idle-minutes N`; `watch` also
  carries the token refresh and the idle watchdog for that server. One bridge terminal per server, opened
  in the first project that needs it and shared by every other project on that server; `autoBridge: false`
  stops the plugin from opening it and the panel shows the `watch` command to run by hand. Settings:
  `remoteCliCommand` (empty → `cliCommand`), `autoBridge` (default true). Capability `terminal:read` added.
  Protocol (v2): every control line ends in `;;` so lines merged by two clients typing into the same
  terminal split cleanly; `batch <id> <b64 {ops, select?, live?}>` carries every queued operation in one
  round trip and answers with one frame; snapshots carry `origin.protocol`, and a client talking to an
  older `watch` falls back to one `call` per operation. The worker queues operations, flushes at once
  when idle and otherwise every 2 s, coalesces repeated settings and paired toggles, and applies
  deterministic operations (policy, budget, balance, keep, clear history, account switch) to the shown
  snapshot immediately; a server-side failure surfaces as `colab.actionFailed`. CLI calls run in two
  lanes (one writer, one reader), reads are cursor-based and adaptive (2 s while the panel is open or an
  answer is due, 10 s otherwise).
  A fully hidden bridge is not possible today: terminals are the only channel Orca gives a plugin to a
  remote host, and `terminal.create` has no hidden mode; anything else (an extra port, SSH) would not work
  for every Orca server a store user may have.
- Install identity `vzxxbacq.colab` (publisher derived from the repo owner).

## Optional remote-workspace mode (not scheduled)

The first design made Colab an Orca remote host via a VM recipe (`contributes.vmRecipes`, `ssh` result,
orcad deployed by Orca). It still works with this repo's notebook and could ship later as a second
recipe for users who *do* want agents on the GPU box. Facts for it are kept in
`docs/orca-plugin-facts.md` § VM recipes. Do not build it unless a TODO item asks.

## Milestones

- **M1 — Skill + CLI usable end to end on macOS.** `doctor`, `setup`, `up`, `run`, `sync`, `pull`,
  `forward`, `down`, `credits`/`ledger` with manual calibration, notebook, SKILL.md, release tag. Exit: a local agent, following the skill, trains a
  toy model on a T4 and pulls the checkpoint back with the user only pressing Run in Colab.
- **M2 — Orca plugin + platforms.** Panel with credit block, status bar, idle watchdog, budget alerts,
  browser calibration via Orca's embedded browser; terminal-launched commands; Linux/Windows paths; abort
  handling; Headscale `loginServer`; auth-key expiry warnings; CI.
- **M3 — Drive automation.** Optional OAuth (`drive.file`): `setup` creates the Drive copy with prefilled
  values; `up` reads the notebook's saved outputs to detect the IP without needing a tailnet peer scan.
- **M4 — Colab Enterprise.** Vertex AI runtime templates and execution jobs: GPU type chosen from the CLI,
  no browser at all, long-running paid runtimes.
- **M5 — Remote-workspace mode** as a second recipe, if asked.

## Known limits

- Colab sessions end (≈90 min idle / 12 h on free, longer on Pro/Pro+); nothing persists on the VM.
  Everything valuable must be `pull`ed or pushed to Git/Drive/HF from Colab.
- GPU type is chosen in Colab's UI until M4.
- Credit figures are estimates: Google publishes no per-GPU rate and no balance API. Rates drift; the
  user recalibrates from the Resources pane, and the panel shows how stale the calibration is.
- Throughput through a DERP relay is a few MB/s: fine for code and logs, wrong for datasets and weights;
  have Colab download those directly.
- Local Tailscale must be installed and signed in; `rsync` recommended (Windows: use WSL's or the tar
  fallback).
- With a remote Orca server, the panel shows the server's state only from the desktop app (browser clients
  load no plugin worker), through a visible `Colab Bridge` terminal that Orca's API cannot close, with
  about 1.5 s of latency and the last 120 log lines of the selected task; full logs stay in the server's
  `~/.orca-colab/tasks/`. `orca-colab` must be runnable on the server (`remoteCliCommand`).
